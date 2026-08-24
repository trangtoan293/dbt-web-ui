"""Publish a project's DuckLake tables as Iceberg tables.

DuckLake is cheap to write - one SQL transaction per commit - but today only
DuckDB reads it. Iceberg is what every other engine reads. So dbt keeps building
marts in the lake, and this publishes them to Iceberg for everything outside
dbt: Spark, Trino, Athena, BigQuery, another team's notebook.

**The Parquet is copied, not registered in place.** Registering the lake's own
files into Iceberg is possible and costs no rewrite, but DuckLake maintenance
(`merge_adjacent_files`, then `cleanup_old_files`) rewrites a table's files and
deletes the old ones, and DuckLake has no knowledge of an Iceberg table pointing
at them - the published table then fails with FileNotFoundError. Two catalogs
each running their own garbage collector cannot share files. Copying is
affordable because what gets published is marts: aggregates, a small fraction of
the raw data the lake holds.

The warehouse directory is deliberately *outside* the lake's data directory, for
the same reason in reverse: `ducklake_delete_orphaned_files` scans the lake's
DATA_PATH and would find these copies unreferenced.

ponytail: full-refresh publish - each call replaces the Iceberg table. Delta
publishing means tracking file-level adds and removes against the previous
snapshot; worth doing when a single mart is big enough that copying it hurts,
not before.
"""

import logging
import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import settings
from ingest import lakehouse

logger = logging.getLogger(__name__)

# pyiceberg stores the catalog name alongside every table it registers and
# filters on it, so a table written under one name is invisible under another.
CATALOG_NAME = "dbt_craft"

_SLUG = re.compile(r"[^a-z0-9]")

# Identifier shape for a schema or table name reaching SQL. Names come from the
# lake catalog rather than from a request, but they are concatenated into
# statements, so they are checked rather than trusted.
_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,62}$")


class IcebergPublishError(RuntimeError):
    """Raised when a publish cannot be completed."""


def _slug(project_id: str) -> str:
    slug = _SLUG.sub("", str(project_id).lower())
    if not slug:
        raise IcebergPublishError("project id is not a usable catalog name")
    return slug[:24]


def catalog_uri() -> str:
    """SQLAlchemy URL for the Iceberg catalog, in its synchronous form.

    Defaults to wherever the DuckLake catalog lives, so the lakehouse keeps one
    metadata store rather than two. pyiceberg uses blocking SQLAlchemy, so the
    async driver this application uses elsewhere would not load.
    """
    url = (
        settings.iceberg_catalog_url
        or settings.lake_catalog_url
        or settings.database_url
        or ""
    )
    if not url:
        raise IcebergPublishError(
            "ICEBERG_CATALOG_URL (or LAKE_CATALOG_URL, or DATABASE_URL) must be set "
            "to publish Iceberg tables"
        )
    for prefix in ("postgresql+asyncpg://", "postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg2://" + url[len(prefix) :]
    return url


def warehouse_dir(project_id: str) -> Path:
    """Directory holding this project's Iceberg data and metadata.

    Never inside lakehouse.data_dir(): the lake's orphan cleanup scans that tree
    and these files are unreferenced from the lake's point of view.
    """
    base = settings.iceberg_warehouse_dir or str(
        Path(settings.storage_dir) / "iceberg"
    )
    return Path(base) / _slug(project_id)


def namespace(project_id: str, schema: str) -> tuple:
    """Iceberg namespace for one project's schema.

    Two-level, because two projects may both publish `marts.orders` and one
    catalog serves the whole deployment.
    """
    return (f"p_{_slug(project_id)}", schema)


def is_configured() -> bool:
    if not lakehouse.is_configured():
        return False
    try:
        catalog_uri()
    except IcebergPublishError:
        return False
    return True


def catalog(project_id: str):
    """Open this project's Iceberg catalog.

    One function so the catalog name and warehouse cannot drift between the
    publisher and anything else that reads what it wrote.
    """
    from pyiceberg.catalog.sql import SqlCatalog

    warehouse = warehouse_dir(project_id)
    warehouse.mkdir(parents=True, exist_ok=True)
    return SqlCatalog(
        CATALOG_NAME, **{"uri": catalog_uri(), "warehouse": f"file://{warehouse}"}
    )


def _validated(name: str, kind: str) -> str:
    if not _IDENTIFIER_RE.match(name or ""):
        raise IcebergPublishError(f"unusable {kind} name: {name!r}")
    return name


def _lake_connection(project_id: str):
    """Attach the project's lake read-only-ish, for listing files and schemas."""
    import duckdb

    connection = duckdb.connect()
    for extension in lakehouse.DUCKDB_EXTENSIONS:
        connection.execute(f"LOAD {extension}")
    # No DATA_PATH, as in lakehouse.maintain: the catalog already records where
    # its files live, and passing a path that disagrees makes the attach fail.
    connection.execute(
        f"ATTACH IF NOT EXISTS '{lakehouse.attach_string(lakehouse.catalog_url())}' "
        f"AS {lakehouse.ATTACH_ALIAS} "
        f"(METADATA_SCHEMA '{lakehouse.metadata_schema(project_id)}')"
    )
    return connection


def _lake_tables(connection, schema: str) -> List[str]:
    rows = connection.execute(
        "SELECT table_name FROM duckdb_tables() "
        "WHERE database_name = ? AND schema_name = ? "
        # dbt's leftovers are not marts.
        "AND table_name NOT LIKE '%__dbt_backup' "
        "ORDER BY table_name",
        [lakehouse.ATTACH_ALIAS, schema],
    ).fetchall()
    return [r[0] for r in rows]


def _data_files(connection, schema: str, table: str) -> List[str]:
    result = connection.execute(
        f"SELECT * FROM ducklake_list_files('{lakehouse.ATTACH_ALIAS}', ?, schema => ?)",
        [table, schema],
    )
    columns = [d[0] for d in result.description]
    if "data_file" not in columns:
        raise IcebergPublishError(
            "this DuckLake build's ducklake_list_files has no data_file column"
        )
    index = columns.index("data_file")
    delete_index = columns.index("delete_file") if "delete_file" in columns else None
    rows = result.fetchall()
    if delete_index is not None and any(r[delete_index] for r in rows):
        # Publishing the data files alone would resurrect deleted rows, which is
        # worse than refusing: the consumer cannot tell.
        raise IcebergPublishError(
            f"{schema}.{table} has pending delete files - run "
            "ducklake_merge_adjacent_files or lakehouse maintenance first"
        )
    return [r[index] for r in rows]


def _copy_dir(project_id: str, schema: str, table: str) -> Path:
    """Where this table's Parquet copies live.

    Computed rather than read from pyiceberg's table.location(), so the layout
    stays ours: add_files takes absolute paths and does not care where they sit.
    """
    return warehouse_dir(project_id) / ".".join(namespace(project_id, schema)) / table / "data"


def _registered_names(catalog, identifier) -> Optional[set]:
    """Basenames of the Parquet files the Iceberg table currently references.

    None means the table does not exist yet. The basename is the join key
    between the lake and the copies: a copy keeps its source file's name, and
    DuckLake names files with a UUID, so it is unique.
    """
    try:
        table = catalog.load_table(identifier)
    except Exception:
        return None
    paths = table.inspect.files().column("file_path").to_pylist()
    return {Path(p).name for p in paths}


def _publish_one(catalog, connection, project_id: str, schema: str, table: str) -> str:
    """Bring one Iceberg table in step with its lake table.

    Appending to the lake - an incremental dbt model - leaves every earlier file
    in place, so only the new ones are copied. A rebuilt table (dbt's `table`
    materialization) or one whose files were rewritten by lake maintenance has a
    file set that is not a superset of what was published, and there is no
    honest delta: that is a full refresh.
    """
    identifier = (*namespace(project_id, schema), table)
    source_files = _data_files(connection, schema, table)
    if not source_files:
        raise IcebergPublishError("table has no data files")

    by_name = {Path(f).name: f for f in source_files}
    published = _registered_names(catalog, identifier)
    target_dir = _copy_dir(project_id, schema, table)

    if published is not None and published <= set(by_name):
        new_names = sorted(set(by_name) - published)
        if not new_names:
            return "unchanged"
        target_dir.mkdir(parents=True, exist_ok=True)
        copied = [_copy(by_name[name], target_dir) for name in new_names]
        catalog.load_table(identifier).add_files(copied)
        return f"incremental: +{len(copied)} file(s)"

    arrow_schema = connection.execute(
        f'SELECT * FROM {lakehouse.ATTACH_ALIAS}."{schema}"."{table}" LIMIT 0'
    ).arrow().schema

    # Full refresh. drop_table removes metadata only, so the previous copies are
    # ours to delete - and only ever inside our own warehouse directory, never
    # the lake's.
    if published is not None:
        catalog.drop_table(identifier)
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    copied = [_copy(source, target_dir) for source in source_files]
    catalog.create_table(identifier, schema=arrow_schema).add_files(copied)
    return f"full: {len(copied)} file(s)"


def _copy(source: str, target_dir: Path) -> str:
    destination = target_dir / Path(source).name
    shutil.copy2(source, destination)
    return str(destination)


def publish(
    project_id: str,
    *,
    schema: str,
    tables: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Replace this project's Iceberg tables from one of its lake schemas.

    Blocking - duckdb, pyiceberg and the file copy are all synchronous. Call it
    in a thread.

    Returns one entry per table so a partial result is visible: one unpublishable
    table must not hide the ones that worked.
    """
    schema = _validated(schema, "schema")
    warehouse = warehouse_dir(project_id)

    connection = _lake_connection(project_id)
    try:
        available = _lake_tables(connection, schema)
        if tables is None:
            selected = available
        else:
            selected = [_validated(t, "table") for t in tables]
            missing = [t for t in selected if t not in available]
            if missing:
                raise IcebergPublishError(
                    f"not in lake schema '{schema}': {', '.join(missing[:5])}"
                )
        if not selected:
            return {"schema": schema, "published": {}, "warehouse": str(warehouse)}

        ice_catalog = catalog(project_id)
        try:
            ice_catalog.create_namespace_if_not_exists(namespace(project_id, schema))
        except Exception as exc:  # older pyiceberg has no _if_not_exists
            logger.debug("namespace create skipped: %s", exc)

        results: Dict[str, str] = {}
        for table in selected:
            try:
                results[table] = _publish_one(
                    ice_catalog, connection, project_id, schema, table
                )
            except Exception as exc:
                results[table] = f"failed: {exc}"
    finally:
        connection.close()

    logger.info("Published %s.%s to Iceberg: %s", project_id, schema, results)
    return {
        "schema": schema,
        "published": results,
        "warehouse": str(warehouse),
        "namespace": ".".join(namespace(project_id, schema)),
    }
