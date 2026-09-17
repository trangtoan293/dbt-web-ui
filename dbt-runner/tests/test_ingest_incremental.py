"""End-to-end: an incremental load reads new rows only, and files can be a source.

The reason this is an end-to-end test rather than a unit test on the hints: what
matters is the row count after the *second* load. Without a cursor, `append`
re-reads the whole source table and doubles it, which no assertion on a mock
would notice.

SQLite source, DuckDB destination, CSV on disk - no running services.
"""

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest.runner import RESULT_PREFIX

RUNNER_CWD = Path(__file__).resolve().parents[1]


def _run_job(config: dict) -> tuple[int, dict, str]:
    """Invoke the runner exactly as the router does: config over stdin."""
    process = subprocess.run(
        [sys.executable, "-m", "ingest.runner"],
        input=json.dumps(config),
        capture_output=True,
        text=True,
        cwd=RUNNER_CWD,
        timeout=300,
    )
    result = {}
    for line in process.stdout.splitlines():
        if line.startswith(RESULT_PREFIX):
            result = json.loads(line[len(RESULT_PREFIX) :].strip())
    return process.returncode, result, process.stdout + process.stderr


@pytest.fixture
def source_db(tmp_path: Path) -> Path:
    path = tmp_path / "source.sqlite"
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE events (id INTEGER PRIMARY KEY, updated_at TEXT, payload TEXT)"
    )
    connection.executemany(
        "INSERT INTO events VALUES (?, ?, ?)",
        [(i, f"2026-01-0{i + 1}", f"row{i}") for i in range(3)],
    )
    connection.commit()
    connection.close()
    return path


def _sql_job(tmp_path: Path, source_db: Path, cursor: str | None) -> dict:
    return {
        "project_id": "p1",
        "pipeline_name": "incr_test",
        "pipelines_dir": str(tmp_path / "dlt"),
        "dataset": "raw",
        "write_disposition": "append",
        "primary_key": None,
        "partition_by": None,
        "cursor_field": cursor,
        "cursor_initial_value": None,
        "source": {
            "type": "sql_database",
            "url": f"sqlite:///{source_db}",
            "tables": ["events"],
        },
        "destination": {"kind": "duckdb", "path": str(tmp_path / "warehouse.duckdb")},
    }


def _row_count(warehouse: Path, table: str) -> int:
    connection = duckdb.connect(str(warehouse), read_only=True)
    try:
        return connection.execute(f"SELECT count(*) FROM raw.{table}").fetchone()[0]
    finally:
        connection.close()


def test_a_cursor_makes_the_second_load_read_nothing_new(tmp_path, source_db):
    job = _sql_job(tmp_path, source_db, cursor="updated_at")
    warehouse = Path(job["destination"]["path"])

    code, result, output = _run_job(job)
    assert code == 0, output
    assert result["row_counts"]["events"] == 3

    code, _, output = _run_job(job)
    assert code == 0, output
    assert _row_count(warehouse, "events") == 3, "an incremental append duplicated rows"


def test_without_a_cursor_an_append_re_reads_everything(tmp_path, source_db):
    """The behaviour the cursor exists to fix, pinned so it stays the contrast."""
    job = _sql_job(tmp_path, source_db, cursor=None)
    warehouse = Path(job["destination"]["path"])

    assert _run_job(job)[0] == 0
    assert _run_job(job)[0] == 0
    assert _row_count(warehouse, "events") == 6


def test_new_rows_past_the_cursor_are_picked_up(tmp_path, source_db):
    job = _sql_job(tmp_path, source_db, cursor="updated_at")
    warehouse = Path(job["destination"]["path"])
    assert _run_job(job)[0] == 0

    connection = sqlite3.connect(source_db)
    connection.execute("INSERT INTO events VALUES (9, '2026-02-01', 'later')")
    connection.commit()
    connection.close()

    code, _, output = _run_job(job)
    assert code == 0, output
    assert _row_count(warehouse, "events") == 4


def test_a_csv_directory_loads_as_a_table(tmp_path, monkeypatch):
    """The filesystem source, through the same runner and the same job shape."""
    data = tmp_path / "drop"
    data.mkdir()
    (data / "part1.csv").write_text("id,name\n1,alice\n2,bob\n")
    (data / "part2.csv").write_text("id,name\n3,carol\n")

    job = {
        "project_id": "p1",
        "pipeline_name": "file_test",
        "pipelines_dir": str(tmp_path / "dlt"),
        "dataset": "raw",
        "write_disposition": "append",
        "primary_key": None,
        "partition_by": None,
        "cursor_field": None,
        "cursor_initial_value": None,
        "source": {
            "type": "filesystem",
            "bucket_url": f"file://{data}",
            "file_glob": "*.csv",
            "format": "csv",
            "table": "dropped_files",
        },
        "destination": {"kind": "duckdb", "path": str(tmp_path / "warehouse.duckdb")},
    }
    code, result, output = _run_job(job)
    assert code == 0, output
    assert result["row_counts"]["dropped_files"] == 3


def test_an_unknown_source_type_fails_the_job_rather_than_loading_nothing(tmp_path):
    job = {
        "project_id": "p1",
        "pipeline_name": "bad_test",
        "pipelines_dir": str(tmp_path / "dlt"),
        "dataset": "raw",
        "write_disposition": "append",
        "cursor_field": None,
        "source": {"type": "python_script", "tables": ["x"]},
        "destination": {"kind": "duckdb", "path": str(tmp_path / "warehouse.duckdb")},
    }
    code, _, output = _run_job(job)
    assert code == 1
    assert "Unknown ingest source type" in output


# --- REST source, against a real HTTP server -------------------------------
#
# A unit test on the config dict is not enough here: dlt has two incremental
# shapes and rejects the wrong one at load time, so nothing short of an actual
# load proves the config is accepted. This is the test that catches
# `ValueErrorWithKnownValues: Received invalid value type=None`.

import json as _json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

_ROWS = [
    {"id": 1, "updated_at": "2026-01-01", "name": "alpha"},
    {"id": 2, "updated_at": "2026-01-02", "name": "beta"},
    {"id": 3, "updated_at": "2026-01-03", "name": "gamma"},
]


class _Handler(BaseHTTPRequestHandler):
    """Answers /items, honouring an `updated_since` filter and an API key."""

    def do_GET(self):  # noqa: N802 - http.server's interface
        if self.headers.get("X-API-Key") != "sekret":
            self.send_response(401)
            self.end_headers()
            return
        since = ""
        if "?" in self.path:
            for part in self.path.split("?", 1)[1].split("&"):
                if part.startswith("updated_since="):
                    since = part.split("=", 1)[1]
        self.server.seen_since.append(since)  # type: ignore[attr-defined]
        rows = [r for r in _ROWS if not since or r["updated_at"] > since]
        body = _json.dumps({"data": rows}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


@pytest.fixture
def api_server():
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    server.seen_since = []  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def _rest_job(
    tmp_path: Path, base_url: str, with_param: bool, monkeypatch
) -> dict:
    from ingest import rest_source

    # The host guard refuses loopback outright and has its own tests
    # (test_ingest_sources.HostGuardTest). What this file is for is the load.
    monkeypatch.setattr(rest_source, "assert_host_allowed", lambda *_a, **_k: None)

    resource = {"name": "items", "path": "items", "data_selector": "data"}
    if with_param:
        resource["incremental_param"] = "updated_since"

    block = rest_source.build_config(
        {"base_url": base_url, "resources": [resource]},
        ["items"],
        {
            "extra_config": {"auth_type": "api_key", "api_key_name": "X-API-Key"},
            "username": None,
        },
        "sekret",
        cursor_field="updated_at",
    )
    return {
        "project_id": "p1",
        "pipeline_name": f"rest_test_{'param' if with_param else 'noparam'}",
        "pipelines_dir": str(tmp_path / "dlt"),
        "dataset": "raw",
        "write_disposition": "append",
        "cursor_field": "updated_at",
        "source": block,
        "destination": {"kind": "duckdb", "path": str(tmp_path / "rest.duckdb")},
    }


def test_a_rest_source_loads_and_dlt_accepts_the_incremental_config(
    tmp_path, api_server, monkeypatch
):
    base = f"http://127.0.0.1:{api_server.server_port}"
    job = _rest_job(tmp_path, base, with_param=True, monkeypatch=monkeypatch)

    code, result, output = _run_job(job)
    assert code == 0, output
    assert result["row_counts"]["items"] == 3

    code, _, output = _run_job(job)
    assert code == 0, output
    assert _row_count(Path(job["destination"]["path"]), "items") == 3

    # The point of start_param: the second call asked the API to filter rather
    # than fetching all three rows again.
    assert api_server.seen_since[0] == ""
    assert api_server.seen_since[-1].startswith("2026-01-03")


def test_without_a_cursor_parameter_the_api_is_asked_for_everything(
    tmp_path, api_server, monkeypatch
):
    """Still correct - dlt dedupes - but every page is fetched every run."""
    base = f"http://127.0.0.1:{api_server.server_port}"
    job = _rest_job(tmp_path, base, with_param=False, monkeypatch=monkeypatch)

    assert _run_job(job)[0] == 0
    assert _run_job(job)[0] == 0
    assert _row_count(Path(job["destination"]["path"]), "items") == 3
    assert set(api_server.seen_since) == {""}
