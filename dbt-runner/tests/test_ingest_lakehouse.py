"""End-to-end ingest into DuckLake, and the two traps that hide inside it.

Trap 1: dlt derives its catalog metadata schema from the DuckLake name while
dbt-duckdb attaches into `public`. Left alone, they build two independent
catalogs over one data directory - the load reports success and dbt then cannot
see the table. `lakehouse.metadata_schema()` is what keeps them together.

Trap 2: DuckLake v1.0 writes small batches into the catalog database rather than
Parquet, so the data quietly ends up inside Postgres. `lakehouse.provision()`
pins `data_inlining_row_limit`.

Uses a SQLite catalog and a SQLite source, so it needs no running services.
"""

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest import lakehouse
from ingest.runner import RESULT_PREFIX

PROJECT_ID = "3f8b1c2d-0000-4000-8000-abcdefabcdef"


@pytest.fixture
def source_db(tmp_path: Path) -> Path:
    path = tmp_path / "source.sqlite"
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)")
    connection.executemany(
        "INSERT INTO customers VALUES (?, ?)", [(i, f"cust{i}") for i in range(4)]
    )
    connection.commit()
    connection.close()
    return path


def _run_job(config: dict, cwd: Path) -> tuple[int, dict, str]:
    """Invoke the runner exactly as the router does: config over stdin."""
    process = subprocess.run(
        [sys.executable, "-m", "ingest.runner"],
        input=json.dumps(config),
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=300,
    )
    result = {}
    for line in process.stdout.splitlines():
        if line.startswith(RESULT_PREFIX):
            result = json.loads(line[len(RESULT_PREFIX) :].strip())
    return process.returncode, result, process.stdout + process.stderr


def _ducklake_config(tmp_path: Path, source_db: Path, catalog: Path) -> dict:
    return {
        "project_id": PROJECT_ID,
        "pipeline_name": "test_ingest",
        "pipelines_dir": str(tmp_path / "dltstate"),
        "dataset": "raw_test",
        "write_disposition": "append",
        "primary_key": None,
        "source": {
            "type": "sql_database",
            "url": f"sqlite:///{source_db}",
            "tables": ["customers"],
        },
        "destination": {
            "kind": "ducklake",
            "catalog_url": f"sqlite:///{catalog}",
            "data_path": str(tmp_path / "lake"),
            "metadata_schema": "main",
            "ducklake_name": lakehouse.ATTACH_ALIAS,
        },
    }


def test_metadata_schema_is_derived_from_the_project():
    """Both writers must land in one catalog, so the name is not a free choice."""
    first = lakehouse.metadata_schema(PROJECT_ID)
    assert first == lakehouse.metadata_schema(PROJECT_ID)
    assert first != lakehouse.metadata_schema("00000000-0000-4000-8000-000000000000")
    # Postgres identifiers cap at 63 bytes and DuckLake appends to this name.
    assert len(first) <= 40
    assert first.replace("_", "").isalnum()


def test_ingest_loads_into_ducklake_and_dbt_can_read_it(tmp_path, source_db):
    # No importorskip: duckdb and dlt are hard dependencies of dbt-runner, so a
    # missing one is a broken environment, not a reason to quietly skip the only
    # end-to-end coverage this feature has.
    import duckdb

    catalog = tmp_path / "catalog.sqlite"
    runner_cwd = Path(__file__).resolve().parents[1]
    config = _ducklake_config(tmp_path, source_db, catalog)

    code, result, output = _run_job(config, runner_cwd)
    assert code == 0, output
    assert result["row_counts"]["customers"] == 4, output

    # Read the way a dbt model does: attach the catalog by its metadata schema.
    connection = duckdb.connect()
    for extension in lakehouse.DUCKDB_EXTENSIONS[:1]:
        connection.execute(f"INSTALL {extension}")
        connection.execute(f"LOAD {extension}")
    connection.execute(
        f"ATTACH 'ducklake:sqlite:{catalog}' AS lake "
        f"(DATA_PATH '{tmp_path / 'lake'}/', METADATA_SCHEMA 'main')"
    )
    rows = connection.execute("SELECT count(*) FROM lake.raw_test.customers").fetchone()
    assert rows[0] == 4, "dbt-side attach cannot see the ingested table"

    # A second run appends rather than replacing, and the state directory the
    # cursor lives in is on the storage volume, not inside the container.
    code, result, output = _run_job(config, runner_cwd)
    assert code == 0, output
    assert result["row_counts"]["customers"] == 8, output
    assert (tmp_path / "dltstate" / "test_ingest").exists()


def test_ingest_writes_parquet_rather_than_inlining_into_the_catalog(
    tmp_path, source_db
):
    """Data must land on the volume, not inside the catalog database.

    Inlined data means the catalog database grows with ingested rows, backups
    split across two systems, and no Parquet to migrate to Iceberg later.
    """
    catalog = tmp_path / "catalog.sqlite"
    config = _ducklake_config(tmp_path, source_db, catalog)
    code, _, output = _run_job(config, Path(__file__).resolve().parents[1])
    assert code == 0, output

    parquet = list((tmp_path / "lake").rglob("*.parquet"))
    assert parquet, f"no Parquet written - data was inlined into the catalog\n{output}"
