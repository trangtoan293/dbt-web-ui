"""Subprocess entry point for one ingest job: `python -m ingest.runner`.

dlt is synchronous and a load can run for minutes, so it must not execute inside
a uvicorn worker. A separate process also makes the job cancellable and keeps its
memory out of the API server.

The job configuration arrives on **stdin**, never as arguments: argv is readable
through `ps` by any process in the container, and the configuration carries a
decrypted warehouse password.

Progress goes to stdout line by line for the SSE stream. The final line is
`__INGEST_RESULT__ {json}` carrying row counts and table locations.

Three source kinds arrive here, all of them already validated by the router:
`sql_database` (a SQLAlchemy URL and a table list), `rest_api` (a dlt
RESTAPIConfig) and `filesystem` (a fenced directory, a glob and a format).
Nothing in this file parses user input - by the time a job reaches stdin the
identifiers, paths, hosts and URLs have all been checked.
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


def _build_source(source: Dict[str, Any]) -> tuple[Any, list[str]]:
    """Return the dlt source (or resource) for this job, and its table names.

    The names are needed twice more - for row counts and for lake partitioning -
    so they come back from here rather than being re-derived per caller and
    disagreeing with what was actually loaded.
    """
    kind = str(source.get("type") or "sql_database")

    if kind == "sql_database":
        from dlt.sources.sql_database import sql_database

        tables = list(source["tables"])
        return sql_database(source["url"], table_names=tables), tables

    if kind == "rest_api":
        from dlt.sources.rest_api import rest_api_source

        resources = source["resources"]
        config = {"client": source["client"], "resources": resources}
        return rest_api_source(config), [str(r["name"]) for r in resources]

    if kind == "filesystem":
        from dlt.sources.filesystem import (
            filesystem,
            read_csv_duckdb,
            read_jsonl,
            read_parquet,
        )

        # CSV goes through duckdb rather than pandas: duckdb is already a
        # dependency of this image and pandas is not.
        readers = {
            "csv": read_csv_duckdb,
            "jsonl": read_jsonl,
            "parquet": read_parquet,
        }
        reader = readers[source["format"]]
        files = filesystem(
            bucket_url=source["bucket_url"], file_glob=source["file_glob"]
        )
        table = str(source["table"])
        return (files | reader()).with_name(table), [table]

    raise ValueError(f"Unknown ingest source type: {kind}")


def _resources(source: Any, tables: list[str]) -> Dict[str, Any]:
    """The per-table resources of a source, whatever shape it arrived in.

    A filesystem source is a single piped resource rather than a source with a
    `resources` mapping, and hints have to be applied the same way for both.
    """
    if hasattr(source, "resources"):
        return {name: source.resources[name] for name in tables if name in source.resources}
    return {tables[0]: source} if tables else {}


def _apply_hints(
    source: Any, tables: list[str], config: Dict[str, Any], kind: str
) -> None:
    """Set the incremental cursor and merge key on every resource.

    Without a cursor a load reads the whole source every time: `append` then
    duplicates it and `merge` only dedupes at the destination, so the source
    warehouse is read in full either way. dlt turns the cursor into
    `WHERE cursor > last_value` pushed down to the source.

    Only the *incremental* is skipped for `rest_api`: its cursor is part of the
    config the router built, because an HTTP cursor has to become a request
    parameter to save any work, which a hint applied here cannot do. The merge
    hints still apply - `run()` passes write_disposition=None for a merge and
    leaves it to this function, so excluding rest_api outright turned every
    REST merge into an append and duplicated the source on each run.
    """
    import dlt

    cursor = config.get("cursor_field")
    primary_key = config.get("primary_key")
    is_merge = config.get("write_disposition") == "merge"
    if not (cursor or is_merge):
        return

    incremental = None
    if cursor and kind != "rest_api":
        incremental = dlt.sources.incremental(
            cursor, initial_value=config.get("cursor_initial_value") or None
        )

    for name, resource in _resources(source, tables).items():
        hints: Dict[str, Any] = {}
        if incremental is not None:
            hints["incremental"] = incremental
        if is_merge:
            hints["write_disposition"] = "merge"
            hints["primary_key"] = primary_key
        if hints:
            resource.apply_hints(**hints)


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

    destination = config["destination"]
    if destination["kind"] == "ducklake":
        from ingest import lakehouse

        lake = lakehouse.LakeRef.from_job_config(destination)
        if lake.managed:
            _emit("[info] provisioning lakehouse catalog")
        else:
            # An external catalog already exists and its write options belong to
            # whoever created it. provision() is still called so the one decision
            # about what a mode may do stays in one place.
            _emit("[info] using an external lakehouse catalog as-is")
        lakehouse.provision(lake)

    write_disposition: Any = config.get("write_disposition") or "append"
    if write_disposition == "merge" and not config.get("primary_key"):
        raise ValueError("write_disposition 'merge' requires a primary key")

    kind = str(config["source"].get("type") or "sql_database")
    source, tables = _build_source(config["source"])
    _emit(f"[info] reading {len(tables)} table(s) from {kind}: {', '.join(tables)}")
    _apply_hints(source, tables, config, kind)
    if config.get("cursor_field"):
        _emit(f"[info] incremental on '{config['cursor_field']}'")

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

    if destination["kind"] == "ducklake" and config.get("partition_by"):
        from ingest import lakehouse

        _emit("[info] applying lake partitioning")
        try:
            applied = lakehouse.apply_partitioning(
                lakehouse.LakeRef.from_job_config(destination),
                dataset=config["dataset"],
                tables=tables,
                partition_by=list(config["partition_by"]),
            )
            _emit(f"[info] partitioning: {applied}")
        except Exception as exc:
            # The rows are already loaded and committed. Failing the job here
            # would report a successful load as failed and invite a re-run.
            _emit(f"[warn] could not apply partitioning: {exc}")

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
