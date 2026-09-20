"""Two tables in one load, each tracking its own column and updating its own way.

This is the thing a single `cursor_field` per source could not express, and the
reason people were creating one ingest source per table - or, more often, no
cursor at all, which makes every run re-read the whole warehouse.

Both halves matter and both are here: that per-table settings are honoured, and
that a job carrying none behaves exactly as it did before they existed.

SQLite source, DuckDB destination - no running services.
"""

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest.runner import RESULT_PREFIX, _table_settings

RUNNER_CWD = Path(__file__).resolve().parents[1]


def _run_job(config: dict) -> tuple[int, dict, str]:
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
    """Two tables that disagree about how they record change, as real ones do."""
    path = tmp_path / "source.sqlite"
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, updated_at TEXT, total REAL)"
    )
    connection.executemany(
        "INSERT INTO orders VALUES (?, ?, ?)",
        [(i, f"2026-01-0{i + 1}", i * 10.0) for i in range(3)],
    )
    # No change stamp at all - the reference table every warehouse has.
    connection.execute("CREATE TABLE regions (code TEXT PRIMARY KEY, name TEXT)")
    connection.executemany(
        "INSERT INTO regions VALUES (?, ?)", [("N", "North"), ("S", "South")]
    )
    connection.commit()
    connection.close()
    return path


def _job(tmp_path: Path, source_db: Path, table_config: dict | None) -> dict:
    return {
        "project_id": "p1",
        "pipeline_name": "table_config_test",
        "pipelines_dir": str(tmp_path / "dlt"),
        "dataset": "raw",
        "write_disposition": "append",
        "primary_key": None,
        "partition_by": None,
        "cursor_field": None,
        "cursor_initial_value": None,
        **({"table_config": table_config} if table_config else {}),
        "source": {
            "type": "sql_database",
            "url": f"sqlite:///{source_db}",
            "tables": ["orders", "regions"],
        },
        "destination": {"kind": "duckdb", "path": str(tmp_path / "warehouse.duckdb")},
    }


def _row_count(warehouse: Path, table: str) -> int:
    connection = duckdb.connect(str(warehouse), read_only=True)
    try:
        return connection.execute(f"SELECT count(*) FROM raw.{table}").fetchone()[0]
    finally:
        connection.close()


# --- the fallback: nothing changes for a source that has no overrides --------


def test_a_job_with_no_table_config_behaves_as_it_always_did(tmp_path, source_db):
    """Two appends with no cursor anywhere still double both tables."""
    job = _job(tmp_path, source_db, None)
    warehouse = Path(job["destination"]["path"])

    assert _run_job(job)[0] == 0
    assert _run_job(job)[0] == 0
    assert _row_count(warehouse, "orders") == 6
    assert _row_count(warehouse, "regions") == 4


def test_settings_fall_back_to_the_job_wide_values():
    job = {
        "cursor_field": "updated_at",
        "cursor_initial_value": "2026-01-01",
        "write_disposition": "merge",
        "primary_key": ["id"],
    }
    assert _table_settings(job, "orders") == {
        "cursor_field": "updated_at",
        "cursor_initial_value": "2026-01-01",
        "write_disposition": "merge",
        "primary_key": ["id"],
    }


def test_a_tables_own_settings_win_over_the_job_wide_ones():
    job = {
        "cursor_field": "updated_at",
        "write_disposition": "append",
        "table_config": {"regions": {"write_disposition": "replace", "cursor_field": None}},
    }
    assert _table_settings(job, "regions")["write_disposition"] == "replace"
    assert _table_settings(job, "regions")["cursor_field"] is None


# --- the point: two tables, two behaviours, one load ------------------------


def test_each_table_tracks_its_own_column_in_one_load(tmp_path, source_db):
    """`orders` is incremental on its own stamp; `regions` is rewritten whole."""
    job = _job(
        tmp_path,
        source_db,
        {
            "orders": {
                "cursor_field": "updated_at",
                "cursor_initial_value": None,
                "write_disposition": "append",
                "primary_key": None,
            },
            "regions": {
                "cursor_field": None,
                "cursor_initial_value": None,
                "write_disposition": "replace",
                "primary_key": None,
            },
        },
    )
    warehouse = Path(job["destination"]["path"])

    code, result, output = _run_job(job)
    assert code == 0, output
    assert result["row_counts"] == {"orders": 3, "regions": 2}

    code, _, output = _run_job(job)
    assert code == 0, output
    # The cursor stopped orders re-reading; replace stopped regions doubling.
    assert _row_count(warehouse, "orders") == 3, "the per-table cursor was not applied"
    assert _row_count(warehouse, "regions") == 2, "replace did not rewrite the table"


def test_one_table_can_merge_while_another_appends(tmp_path, source_db):
    job = _job(
        tmp_path,
        source_db,
        {
            "orders": {
                "cursor_field": None,
                "cursor_initial_value": None,
                "write_disposition": "merge",
                "primary_key": ["id"],
            },
            "regions": {
                "cursor_field": None,
                "cursor_initial_value": None,
                "write_disposition": "append",
                "primary_key": None,
            },
        },
    )
    warehouse = Path(job["destination"]["path"])

    assert _run_job(job)[0] == 0
    code, _, output = _run_job(job)
    assert code == 0, output
    assert _row_count(warehouse, "orders") == 3, "merge duplicated on the primary key"
    assert _row_count(warehouse, "regions") == 4, "append did not append"


# --- what the router resolves before the job is ever sent -------------------


def _resolve(stored: dict | None, tables: list[str], **kwargs):
    from app.routers.ingest import _validated_table_config

    defaults = dict(
        source_cursor=None,
        source_primary_key=None,
        source_disposition="append",
        disposition_is_override=False,
    )
    return _validated_table_config(
        {"table_config": stored}, "sql_database", tables, **{**defaults, **kwargs}
    )


def test_every_table_is_resolved_even_when_it_overrode_nothing():
    """The runner reads one map; it should never have to ask what is missing."""
    resolved = _resolve(None, ["a", "b"], source_cursor="updated_at")
    assert set(resolved) == {"a", "b"}
    assert resolved["a"]["cursor_field"] == "updated_at"


def test_settings_for_a_table_not_in_the_load_are_refused():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as caught:
        _resolve({"ghost": {"writeDisposition": "replace"}}, ["a"])
    assert "ghost" in caught.value.detail


def test_a_cursor_that_is_not_a_column_name_is_refused():
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        _resolve({"a": {"cursorField": "updated_at; DROP TABLE x"}}, ["a"])


def test_a_table_does_not_inherit_a_start_value_meant_for_another_column():
    """`2026-01-01` bounds the source's cursor, not whatever this table tracks."""
    resolved = _resolve(
        {"a": {"cursorField": "modified_on"}},
        ["a"],
        source_cursor="updated_at",
    )
    # The source row's own initial value is absent here, so the check that
    # matters is that a differing cursor does not carry one over.
    assert resolved["a"]["cursor_field"] == "modified_on"
    assert resolved["a"]["cursor_initial_value"] is None


def test_a_one_off_disposition_override_beats_every_table():
    resolved = _resolve(
        {"a": {"writeDisposition": "merge", "primaryKey": ["id"]}},
        ["a", "b"],
        source_disposition="replace",
        disposition_is_override=True,
    )
    assert resolved["a"]["write_disposition"] == "replace"
    assert resolved["b"]["write_disposition"] == "replace"


def test_a_table_may_merge_on_the_loads_primary_key():
    resolved = _resolve(
        {"a": {"writeDisposition": "merge"}}, ["a"], source_primary_key=["id"]
    )
    assert resolved["a"]["primary_key"] == ["id"]


def test_merge_with_no_key_anywhere_is_refused_at_the_router():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as caught:
        _resolve({"a": {"writeDisposition": "merge"}}, ["a"])
    assert "primary key" in caught.value.detail


def test_a_table_asking_to_merge_without_a_key_fails_before_loading(tmp_path, source_db):
    job = _job(
        tmp_path,
        source_db,
        {
            "orders": {
                "cursor_field": None,
                "cursor_initial_value": None,
                "write_disposition": "merge",
                "primary_key": None,
            }
        },
    )
    code, _, output = _run_job(job)
    assert code != 0
    assert "primary key" in output.lower()
