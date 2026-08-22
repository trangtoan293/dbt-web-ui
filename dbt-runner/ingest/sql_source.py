"""Turn a stored Connection into a SQLAlchemy URL that dlt can read from.

Ingest sources reference an existing row in `connections` rather than storing
their own credentials, so there is exactly one place in the product where a
warehouse password lives.
"""

from typing import Any, Dict
from urllib.parse import quote

from app.core.host_guard import assert_host_allowed

# Only connection types with a synchronous SQLAlchemy driver in the image can be
# read table-by-table. Dremio and Spark have no dialect here, and DuckDB files
# are already local to dbt - none of them are ingest sources.
SOURCE_DRIVERS = {
    "postgresql": "postgresql+psycopg2",
    "oracle": "oracle+oracledb",
}


class UnsupportedSource(ValueError):
    """Raised when a connection type cannot act as an ingest source."""


def supported_source_types() -> list[str]:
    return sorted(SOURCE_DRIVERS)


def build_source_url(connection: Dict[str, Any], secret: str) -> str:
    """Build a SQLAlchemy URL for a `connections` row.

    Raises:
        UnsupportedSource: the connection type has no driver in this image.
        HostNotAllowed: the target host is refused by policy.
    """
    conn_type = connection.get("connection_type")
    driver = SOURCE_DRIVERS.get(conn_type)
    if not driver:
        raise UnsupportedSource(
            f"Connection type '{conn_type}' cannot be used as an ingest source. "
            f"Supported: {', '.join(supported_source_types())}"
        )

    host = connection.get("host") or ""
    port = int(connection.get("port") or 0) or None
    assert_host_allowed(host, port)

    database = connection.get("database") or ""
    extra = dict(connection.get("extra_config") or {})
    if conn_type == "oracle":
        # oracledb reaches a service through the /service_name suffix.
        database = extra.get("service") or database

    user = quote(str(connection.get("username") or ""), safe="")
    password = quote(secret or "", safe="")
    credentials = f"{user}:{password}@" if user else ""
    port_part = f":{port}" if port else ""
    return f"{driver}://{credentials}{host}{port_part}/{quote(database, safe='')}"
