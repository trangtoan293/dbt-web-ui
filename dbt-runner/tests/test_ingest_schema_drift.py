"""What happens when the source grows a column between two loads.

Schema drift is the failure that looks like success: the load finishes, the new
column is silently absent or silently added, and whoever reads the table
downstream finds out weeks later. Which of the two it should be is a decision,
so it is stored on the source and enforced by dlt's schema contract rather than
left to whatever the library defaults to.

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

from ingest.runner import RESULT_PREFIX, schema_contract

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
    path = tmp_path / "source.sqlite"
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)")
    connection.executemany(
        "INSERT INTO orders VALUES (?, ?)", [(i, i * 10.0) for i in range(3)]
    )
    connection.commit()
    connection.close()
    return path


def _add_column(source_db: Path) -> None:
    """The upstream change nobody told the pipeline about."""
    connection = sqlite3.connect(source_db)
    connection.execute("ALTER TABLE orders ADD COLUMN currency TEXT DEFAULT 'VND'")
    connection.execute("INSERT INTO orders VALUES (9, 90.0, 'USD')")
    connection.commit()
    connection.close()


def _job(tmp_path: Path, source_db: Path, contract: str) -> dict:
    return {
        "project_id": "p1",
        "pipeline_name": "drift_test",
        "pipelines_dir": str(tmp_path / "dlt"),
        "dataset": "raw",
        "write_disposition": "append",
        "primary_key": None,
        "partition_by": None,
        "cursor_field": None,
        "cursor_initial_value": None,
        "schema_contract": contract,
        "source": {
            "type": "sql_database",
            "url": f"sqlite:///{source_db}",
            "tables": ["orders"],
        },
        "destination": {"kind": "duckdb", "path": str(tmp_path / "warehouse.duckdb")},
    }


# --- the contract itself ---------------------------------------------------


def test_evolve_lets_tables_and_columns_appear():
    assert schema_contract("evolve") == {
        "tables": "evolve",
        "columns": "evolve",
        "data_type": "evolve",
    }


def test_freeze_still_allows_a_new_table():
    """A load's first run creates its tables; freezing those makes it unusable.

    What is frozen is a *column* appearing in a table that already exists,
    which is the drift someone wants to hear about.
    """
    assert schema_contract("freeze")["tables"] == "evolve"
    assert schema_contract("freeze")["columns"] == "freeze"


def test_an_unknown_policy_falls_back_to_evolve():
    """Today's behaviour is the default, for every row written before this."""
    assert schema_contract(None) == schema_contract("evolve")
    assert schema_contract("nonsense") == schema_contract("evolve")


# --- and what it does to a real load ---------------------------------------


def test_evolve_adds_the_new_column_on_the_next_load(tmp_path, source_db):
    job = _job(tmp_path, source_db, "evolve")
    assert _run_job(job)[0] == 0

    _add_column(source_db)
    code, _, output = _run_job(job)
    assert code == 0, output

    connection = duckdb.connect(str(tmp_path / "warehouse.duckdb"), read_only=True)
    try:
        columns = [
            row[0]
            for row in connection.execute("DESCRIBE raw.orders").fetchall()
        ]
    finally:
        connection.close()
    assert "currency" in columns, "evolve did not take the new column"


def test_freeze_stops_the_load_instead_of_absorbing_the_change(tmp_path, source_db):
    job = _job(tmp_path, source_db, "freeze")
    assert _run_job(job)[0] == 0, "the first load creates the table and must succeed"

    _add_column(source_db)
    code, _, output = _run_job(job)
    assert code != 0, "freeze let an unannounced column through"
    assert "currency" in output, f"the failure did not name the column: {output[-2000:]}"
