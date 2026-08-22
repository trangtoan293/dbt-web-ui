"""Subprocess entry point for one ingest job: `python -m ingest.runner`.

dlt is synchronous and a load can run for minutes, so it must not execute inside
a uvicorn worker. A separate process also makes the job cancellable and keeps its
memory out of the API server.

The job configuration arrives on **stdin**, never as arguments: argv is readable
through `ps` by any process in the container, and the configuration carries a
decrypted warehouse password.

Progress goes to stdout line by line for the SSE stream. The final line is
`__INGEST_RESULT__ {json}` carrying row counts and table locations.
"""

import json
import os
import sys
from typing import Any, Dict

RESULT_PREFIX = "__INGEST_RESULT__"


def _emit(message: str) -> None:
    print(message, flush=True)


def _configure_destination(destination: Dict[str, Any]) -> Any:
    """Return the dlt destination for this job, configuring it from env."""
    import dlt

    kind = destination["kind"]

    if kind == "ducklake":
        prefix = "DESTINATION__DUCKLAKE__CREDENTIALS__"
        os.environ[f"{prefix}CATALOG"] = destination["catalog_url"]
        os.environ[f"{prefix}STORAGE__BUCKET_URL"] = (
            f"file://{destination['data_path']}"
        )
        os.environ[f"{prefix}DUCKLAKE_NAME"] = destination["ducklake_name"]
        # Pinned explicitly: dlt would otherwise derive it from the DuckLake name
        # and land in a different catalog than the one dbt attaches.
        os.environ[f"{prefix}METADATA_SCHEMA"] = destination["metadata_schema"]
        return "ducklake"

    if kind == "duckdb":
        return dlt.destinations.duckdb(credentials=destination["path"])

    if kind == "postgres":
        return dlt.destinations.postgres(
            credentials={
                "host": destination["host"],
                "port": destination["port"],
                "username": destination["user"],
                "password": destination["password"],
                "database": destination["database"],
            }
        )

    raise ValueError(f"Unknown destination kind: {kind}")


def _row_counts(pipeline: Any, tables: list[str]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    try:
        with pipeline.sql_client() as client:
            for table in tables:
                try:
                    rows = client.execute_sql(f"SELECT count(*) FROM {table}")
                    counts[table] = int(rows[0][0]) if rows else 0
                except Exception:
                    # A table the source declared but never produced is not an error.
                    continue
    except Exception as exc:  # counting is reporting, never the job's verdict
        _emit(f"[warn] could not read row counts: {exc}")
    return counts


def run(config: Dict[str, Any]) -> int:
    # Keep dlt from echoing connection strings into the log stream.
    os.environ.setdefault("RUNTIME__LOG_LEVEL", "WARNING")
    # Bound resident memory: without this dlt buffers large extracts in RAM, and
    # an OOM here takes down the whole runner container on a small box.
    os.environ.setdefault("DATA_WRITER__BUFFER_MAX_ITEMS", "5000")

    import dlt
    from dlt.sources.sql_database import sql_database

    destination = config["destination"]
    if destination["kind"] == "ducklake":
        from ingest import lakehouse

        _emit("[info] provisioning lakehouse catalog")
        lakehouse.provision(
            catalog=destination["catalog_url"],
            data_path=destination["data_path"],
            metadata=destination["metadata_schema"],
        )

    tables = list(config["source"]["tables"])
    _emit(f"[info] reading {len(tables)} table(s): {', '.join(tables)}")

    source = sql_database(config["source"]["url"], table_names=tables)

    write_disposition: Any = config.get("write_disposition") or "append"
    primary_key = config.get("primary_key") or None
    if write_disposition == "merge":
        if not primary_key:
            raise ValueError("write_disposition 'merge' requires a primary key")
        source = source.with_resources(*tables)
        for table in tables:
            source.resources[table].apply_hints(
                write_disposition="merge", primary_key=primary_key
            )

    pipeline = dlt.pipeline(
        pipeline_name=config["pipeline_name"],
        destination=_configure_destination(destination),
        dataset_name=config["dataset"],
        pipelines_dir=config["pipelines_dir"],
        progress=dlt.progress.log(dump_system_stats=False),
    )

    _emit(f"[info] loading into {destination['kind']}.{config['dataset']}")
    info = pipeline.run(
        source,
        write_disposition=write_disposition if write_disposition != "merge" else None,
    )
    _emit(f"[info] {info}")

    counts = _row_counts(pipeline, tables)
    result = {
        "dataset": config["dataset"],
        "destination": destination["kind"],
        "row_counts": counts,
        "data_path": destination.get("data_path"),
    }
    _emit(f"{RESULT_PREFIX} {json.dumps(result)}")
    return 0


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        _emit("[error] no configuration received on stdin")
        return 2
    try:
        config = json.loads(raw)
    except json.JSONDecodeError as exc:
        _emit(f"[error] configuration is not valid JSON: {exc}")
        return 2

    try:
        return run(config)
    except Exception as exc:
        # Never re-emit the config: it holds a decrypted password.
        _emit(f"[error] {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
