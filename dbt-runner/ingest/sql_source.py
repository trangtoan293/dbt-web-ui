"""Turn a stored Connection into a SQLAlchemy URL that dlt can read from.

Ingest sources reference an existing row in `connections` rather than storing
their own credentials, so there is exactly one place in the product where a
warehouse password lives.

Some of these types are ingest sources *only*: MySQL has no dbt adapter in this
image, in the same way `ducklake` is a connection type dbt never runs against.
That is why the table listing and connection probe live here rather than in
`adapters/` - a source-only type has no adapter to ask, and adding one to the
registry would offer a warehouse dbt cannot actually run.
"""

from typing import Any, Dict, List
from urllib.parse import quote

from app.core.host_guard import assert_host_allowed

# Only connection types with a synchronous SQLAlchemy driver in the image can be
# read table-by-table. Dremio and Spark have no dialect here, and DuckDB files
# are already local to dbt - none of them are ingest sources.
SOURCE_DRIVERS = {
    "postgresql": "postgresql+psycopg2",
    "oracle": "oracle+oracledb",
    "mysql": "mysql+pymysql",
}

# Source types this image can read but dbt cannot run against, so they never
# reach the adapter registry. `/connection/test`, `/connection/schema` and the
# ingest table picker fall back to `probe`/`inspect_tables` for these.
SOURCE_ONLY_TYPES = frozenset({"mysql"})


class UnsupportedSource(ValueError):
    """Raised when a connection type cannot act as an ingest source."""


def supported_source_types() -> list[str]:
    return sorted(SOURCE_DRIVERS)


def build_url(
    conn_type: str,
    *,
    host: str,
    port: Any,
    database: str,
    username: str,
    password: str,
    extra: Dict[str, Any] | None = None,
) -> str:
    """Build a SQLAlchemy URL for one supported source type.

    The single URL builder: `build_source_url` feeds it a `connections` row and
    the connection-test endpoint feeds it a request body, because those two carry
    the same facts under different key names and only one of them should know how
    a DSN is assembled.

    Raises:
        UnsupportedSource: the connection type has no driver in this image.
        HostNotAllowed: the target host is refused by policy.
    """
    driver = SOURCE_DRIVERS.get(conn_type)
    if not driver:
        raise UnsupportedSource(
            f"Connection type '{conn_type}' cannot be used as an ingest source. "
            f"Supported: {', '.join(supported_source_types())}"
        )

    port_number = int(port or 0) or None
    assert_host_allowed(host or "", port_number)

    if conn_type == "oracle":
        # oracledb reaches a service through the /service_name suffix.
        database = (extra or {}).get("service") or database

    user = quote(str(username or ""), safe="")
    secret = quote(password or "", safe="")
    credentials = f"{user}:{secret}@" if user else ""
    port_part = f":{port_number}" if port_number else ""
    return f"{driver}://{credentials}{host}{port_part}/{quote(database or '', safe='')}"


def build_source_url(connection: Dict[str, Any], secret: str) -> str:
    """Build a SQLAlchemy URL for a `connections` row."""
    return build_url(
        str(connection.get("connection_type") or ""),
        host=str(connection.get("host") or ""),
        port=connection.get("port"),
        database=str(connection.get("database") or ""),
        username=str(connection.get("username") or ""),
        password=secret or "",
        extra=dict(connection.get("extra_config") or {}),
    )


def build_url_from_config(conn_type: str, config: Dict[str, Any]) -> str:
    """Build a URL from a connection-test request body.

    The frontend sends adapter-shaped config, whose key names differ per type
    (`dbname` for Postgres, `service` for Oracle), so every spelling this
    application uses for one fact is accepted here.
    """
    config = config or {}
    database = (
        config.get("database") or config.get("dbname") or config.get("service") or ""
    )
    return build_url(
        conn_type,
        host=str(config.get("host") or ""),
        port=config.get("port"),
        database=str(database),
        username=str(config.get("user") or config.get("username") or ""),
        password=str(config.get("password") or ""),
        extra={"service": config.get("service")} if config.get("service") else None,
    )


def _engine(url: str):
    """A short-lived engine that does not pool: these calls are one-shot.

    Imported lazily so `build_url` stays usable without a database driver
    installed - the URL builder is what the unit tests exercise.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.pool import NullPool

    return create_engine(url, poolclass=NullPool)


def probe(url: str) -> Dict[str, Any]:
    """Open the connection and run the cheapest possible statement.

    Blocking. Call it from a thread - see the callers in `app/routers`.
    """
    from sqlalchemy import text

    engine = _engine(url)
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"success": True, "message": "Connection successful"}
    except Exception as exc:
        return {"success": False, "message": str(exc)}
    finally:
        engine.dispose()


def inspect_tables(url: str) -> List[str]:
    """Table and view names visible on the connection's default schema.

    Blocking, for the same reason as `probe`.
    """
    from sqlalchemy import inspect

    engine = _engine(url)
    try:
        inspector = inspect(engine)
        return sorted(set(inspector.get_table_names()) | set(inspector.get_view_names()))
    finally:
        engine.dispose()
