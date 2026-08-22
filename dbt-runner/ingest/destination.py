"""Where an ingest job writes: the project's own warehouse, or the lakehouse.

The returned dicts are plain JSON, because the runner receives its whole
configuration over stdin - see ingest/runner.py.
"""

from pathlib import Path
from typing import Any, Dict

from ingest import lakehouse

# Destination kinds a source row may ask for.
DESTINATION_CONNECTION = "connection"
DESTINATION_LAKEHOUSE = "ducklake"
DESTINATIONS = (DESTINATION_CONNECTION, DESTINATION_LAKEHOUSE)

# Warehouses dlt can load into directly. Dremio, Oracle and Spark have no dlt
# destination; those projects ingest into the lakehouse and read it from dbt.
WAREHOUSE_DESTINATIONS = {"duckdb", "postgresql"}


class UnsupportedDestination(ValueError):
    """Raised when a destination cannot be built from the given config."""


def build_destination(
    kind: str,
    *,
    project_id: str,
    connection_type: str | None = None,
    connection_config: Dict[str, Any] | None = None,
    connection_secret: str = "",
) -> Dict[str, Any]:
    """Describe the dlt destination for one ingest job."""
    if kind == DESTINATION_LAKEHOUSE:
        return {
            "kind": DESTINATION_LAKEHOUSE,
            "catalog_url": lakehouse.catalog_url(),
            "data_path": str(lakehouse.data_dir(project_id)),
            "metadata_schema": lakehouse.metadata_schema(project_id),
            "ducklake_name": lakehouse.ATTACH_ALIAS,
        }

    if kind != DESTINATION_CONNECTION:
        raise UnsupportedDestination(
            f"Unknown destination '{kind}'. Supported: {', '.join(DESTINATIONS)}"
        )

    config = connection_config or {}
    if connection_type not in WAREHOUSE_DESTINATIONS:
        raise UnsupportedDestination(
            f"A {connection_type} project cannot be loaded into directly. Choose the "
            f"'{DESTINATION_LAKEHOUSE}' destination and read it from dbt instead."
        )

    if connection_type == "duckdb":
        path = config.get("path") or ""
        if not path or path == ":memory:":
            raise UnsupportedDestination(
                "the project's DuckDB connection has no file path to load into"
            )
        # Relative paths in a profile are resolved against the dbt project dir;
        # the runner has no such cwd, so refuse rather than write to the wrong file.
        if not Path(path).is_absolute():
            raise UnsupportedDestination(
                f"the project's DuckDB path '{path}' is relative - set an absolute "
                "path on the connection to load into it"
            )
        return {"kind": "duckdb", "path": path}

    host = config.get("host") or ""
    port = config.get("port") or 5432
    user = config.get("user") or ""
    database = config.get("dbname") or config.get("database") or ""
    return {
        "kind": "postgres",
        "host": host,
        "port": int(port),
        "user": user,
        "password": connection_secret,
        "database": database,
    }
