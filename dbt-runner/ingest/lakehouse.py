"""DuckLake lakehouse layout, shared by the ingest runner and dbt profiles.

The catalog is a set of metadata tables in a SQL database; the data files are
Parquet on the storage volume. Both dlt (writing raw tables) and dbt (reading
them, writing marts) must attach *the same* catalog, which means agreeing on the
metadata schema. They do not agree by default: dlt derives the metadata schema
from the DuckLake name while dbt-duckdb attaches into `public`, which silently
produces two independent catalogs over one data directory - ingest reports
success and dbt then fails with `schema ... does not exist`. Every attach in
this codebase therefore goes through metadata_schema() below.

One catalog per project: the metadata schema and the data directory are both
derived from the project id, so project ownership stays the only access rule and
deleting a project is a schema drop plus an rmtree.

ponytail: per-project catalogs, not one shared company lakehouse. Cross-project
sharing needs a grant model that does not exist here yet; a shared catalog is a
config change in this module when it does.
"""

import logging
import re
from pathlib import Path
from urllib.parse import urlparse

from app.config import settings

logger = logging.getLogger(__name__)

# Alias the lake is attached under, so model SQL reads `lake.raw_x.orders`
# identically in every project.
ATTACH_ALIAS = "lake"

# dbt renders env_var() in profiles.yml, so the catalog password reaches DuckDB
# without ever being written to disk.
CATALOG_PASSWORD_ENV = "DBT_ENV_SECRET_LAKE_CATALOG_PASSWORD"

DUCKDB_EXTENSIONS = ("ducklake", "postgres")

_UUID_CHARS = re.compile(r"[^a-z0-9]")


class LakehouseError(RuntimeError):
    """Raised when the lake cannot be located or provisioned."""


def _configured_catalog_url() -> str:
    """The catalog URL, falling back to the application database.

    The fallback is resolved here rather than in the Settings default:
    docker-compose passes `LAKE_CATALOG_URL: ${LAKE_CATALOG_URL:-}`, and
    pydantic-settings honours that empty string, which would overwrite any
    default computed at class definition time.
    """
    return settings.lake_catalog_url or settings.database_url or ""


def is_configured() -> bool:
    return bool(_configured_catalog_url())


def metadata_schema(project_id: str) -> str:
    """Metadata schema holding this project's DuckLake catalog tables."""
    slug = _UUID_CHARS.sub("", str(project_id).lower())
    if not slug:
        raise LakehouseError("project id is not a usable catalog name")
    # Postgres identifiers cap at 63 bytes and DuckLake appends to this name.
    return f"lake_{slug[:24]}"


def data_dir(project_id: str) -> Path:
    """Directory holding this project's Parquet files."""
    base = settings.lake_data_dir or str(Path(settings.storage_dir) / "lake")
    slug = _UUID_CHARS.sub("", str(project_id).lower())
    if not slug:
        raise LakehouseError("project id is not a usable data path")
    return Path(base) / slug


def catalog_url() -> str:
    """Configured catalog URL, as dlt's DuckLake catalog credentials expect."""
    url = _configured_catalog_url()
    if not url:
        raise LakehouseError(
            "LAKE_CATALOG_URL (or DATABASE_URL) must be set to use a lakehouse destination"
        )
    return url


def catalog_password() -> str:
    return urlparse(catalog_url()).password or ""


def attach_string(url: str, *, password: str | None = None) -> str:
    """Build the `ducklake:...` string DuckDB attaches for a catalog URL.

    Pass a password to substitute for the one in the URL - the dbt profile passes
    an env_var() reference so the secret never lands in profiles.yml.
    """
    parsed = urlparse(url)
    scheme = parsed.scheme.split("+")[0]

    if scheme in ("sqlite", "file", ""):
        # DuckLake takes a plain file path. Both sqlite:///x and sqlite:////x are
        # written in the wild, so collapse the leading slashes to one.
        path = parsed.path or url
        return f"ducklake:sqlite:/{path.lstrip('/')}"

    if scheme not in ("postgres", "postgresql"):
        raise LakehouseError(
            f"Unsupported lakehouse catalog scheme '{parsed.scheme}'. Use postgresql:// or sqlite:///"
        )

    database = parsed.path.lstrip("/")
    if not parsed.hostname or not database:
        raise LakehouseError("lakehouse catalog URL is missing a host or database name")
    secret = parsed.password or "" if password is None else password
    return (
        f"ducklake:postgres:dbname={database} host={parsed.hostname} "
        f"port={parsed.port or 5432} user={parsed.username or ''} password={secret}"
    )


def dbt_attach_entry(project_id: str) -> dict:
    """The `attach:` entry for a dbt-duckdb profile pointing at this lake."""
    return {
        "path": attach_string(
            catalog_url(), password=f"{{{{ env_var('{CATALOG_PASSWORD_ENV}') }}}}"
        ),
        "alias": ATTACH_ALIAS,
        "is_ducklake": True,
        "options": {
            "data_path": f"{data_dir(project_id)}/",
            "metadata_schema": metadata_schema(project_id),
        },
    }


def provision(
    *,
    catalog: str,
    data_path: str,
    metadata: str,
    inline_row_limit: int | None = None,
) -> None:
    """Create a project's catalog and pin its write behaviour.

    Idempotent: safe to call before every load. Attaching creates the metadata
    schema when absent; the inlining limit is stored in the catalog itself, so
    one call covers every later writer, dlt and dbt alike.

    Takes the catalog explicitly rather than reading settings, so the runner
    provisions exactly the catalog its job configuration names.
    """
    import duckdb

    directory = Path(data_path)
    directory.mkdir(parents=True, exist_ok=True)
    limit = (
        settings.lake_inline_row_limit if inline_row_limit is None else inline_row_limit
    )

    connection = duckdb.connect()
    try:
        for extension in DUCKDB_EXTENSIONS:
            connection.execute(f"INSTALL {extension}")
            connection.execute(f"LOAD {extension}")
        connection.execute(
            f"ATTACH IF NOT EXISTS '{attach_string(catalog)}' AS {ATTACH_ALIAS} "
            f"(DATA_PATH '{directory}/', METADATA_SCHEMA '{metadata}')"
        )
        connection.execute(
            f"CALL {ATTACH_ALIAS}.set_option('data_inlining_row_limit', {int(limit)})"
        )
    except Exception as exc:  # duckdb raises a wide range of catalog errors
        raise LakehouseError(f"could not provision the lakehouse: {exc}") from exc
    finally:
        connection.close()

    logger.info(
        "Provisioned lake (schema=%s data=%s inlining=%s)", metadata, directory, limit
    )


_PARTITION_FUNCTIONS = ("year", "month", "day", "hour")
_IDENTIFIER = r"[A-Za-z_][A-Za-z0-9_$]{0,62}"
# Two alternatives rather than an optional paren group: `ts)` matches the
# optional form and is not a term, and an "is it balanced" check after the fact
# is a second place to get this wrong.
_PARTITION_TERM_RE = re.compile(
    rf"^(?:(?P<fn>[A-Za-z]+)\((?P<fn_column>{_IDENTIFIER})\)|(?P<column>{_IDENTIFIER}))$"
)


def partition_expression(term: str) -> str:
    """Validate one partition term and return it as SQL.

    `ALTER TABLE ... SET PARTITIONED BY` takes an expression, so this cannot be a
    bound parameter - it is concatenated into DDL. Only a bare column or one of a
    fixed set of date-part functions over a bare column is accepted, which is
    what partitioning a warehouse table actually needs and leaves nothing to
    inject.
    """
    raw = (term or "").strip()
    match = _PARTITION_TERM_RE.match(raw)
    if not match:
        raise LakehouseError(
            f"invalid partition term '{term}': use a column name, "
            f"or one of {', '.join(_PARTITION_FUNCTIONS)}(column)"
        )
    function = match.group("fn")
    if function is None:
        return f'"{match.group("column")}"'
    if function.lower() not in _PARTITION_FUNCTIONS:
        raise LakehouseError(
            f"unsupported partition function '{function}': "
            f"use one of {', '.join(_PARTITION_FUNCTIONS)}"
        )
    return f'{function.lower()}("{match.group("fn_column")}")'


def apply_partitioning(
    *,
    catalog: str,
    metadata: str,
    dataset: str,
    tables: list[str],
    partition_by: list[str],
) -> dict:
    """Partition a dataset's lake tables, so later scans can prune files.

    Without this a query filtering on a date reads every Parquet file in the
    table - at a few hundred GB that is the difference between seconds and
    minutes, and no engine choice fixes it.

    ponytail: DuckLake applies a partition spec to *subsequent* writes, so the
    first load's files stay unpartitioned until merge_adjacent_files rewrites
    them. Called after the load rather than before because the table does not
    exist until then.

    Returns one entry per table so a partial result is visible. Never raises for
    a single table: a source whose tables do not all share a date column is
    normal, and a failed partition is not a failed load.
    """
    import duckdb

    expressions = [partition_expression(term) for term in partition_by if str(term).strip()]
    if not expressions:
        return {}

    results: dict[str, str] = {}
    connection = duckdb.connect()
    try:
        for extension in DUCKDB_EXTENSIONS:
            connection.execute(f"LOAD {extension}")
        connection.execute(
            f"ATTACH IF NOT EXISTS '{attach_string(catalog)}' AS {ATTACH_ALIAS} "
            f"(METADATA_SCHEMA '{metadata}')"
        )
        for table in tables:
            # dataset and table are validated identifiers upstream (_DATASET_RE,
            # _TABLE_RE in the ingest router); quoted here as well.
            target = f'{ATTACH_ALIAS}."{dataset}"."{table}"'
            try:
                connection.execute(
                    f"ALTER TABLE {target} SET PARTITIONED BY ({', '.join(expressions)})"
                )
                results[table] = "ok"
            except Exception as exc:
                results[table] = f"skipped: {exc}"
    except Exception as exc:
        raise LakehouseError(f"could not partition the lakehouse tables: {exc}") from exc
    finally:
        connection.close()

    logger.info("Lake partitioning for %s: %s", dataset, results)
    return results


# Maintenance entry points, by the name each DuckLake version exposes. The
# extension is baked into the image, so which of these exist depends on that
# build - every step is therefore attempted independently and a missing
# function is reported, not fatal.
_MAINTENANCE_STEPS = (
    # Merge first: appending loads leave many small Parquet files, and a scan
    # pays per file. Merging is what makes the old ones unreferenced, so snapshot
    # expiry below can then release them - the other order merges files that are
    # about to be dropped and keeps the small ones another retention window.
    ("merge_adjacent_files", "CALL ducklake_merge_adjacent_files('{alias}')"),
    (
        "expire_snapshots",
        "CALL ducklake_expire_snapshots('{alias}', older_than => now() - INTERVAL '{days} days')",
    ),
    ("cleanup_old_files", "CALL ducklake_cleanup_old_files('{alias}', cleanup_all => true)"),
    (
        "delete_orphaned_files",
        "CALL ducklake_delete_orphaned_files('{alias}', older_than => now() - INTERVAL '{days} days')",
    ),
)


def maintain(project_id: str, *, retention_days: int) -> dict:
    """Expire old snapshots, drop dbt's backup tables, and delete dead files.

    DuckLake keeps every snapshot and dbt-duckdb leaves `__dbt_backup` tables
    behind, so an ingesting project's storage only ever grows. Called from the
    scheduler, once per project with a lakehouse-bound source.

    Blocking (duckdb is synchronous) - call it in a thread. Returns one entry
    per step so a partial success is visible rather than silent.
    """
    import duckdb

    if retention_days < 0:
        raise LakehouseError("retention_days cannot be negative")

    metadata = metadata_schema(project_id)
    results: dict[str, str] = {}

    connection = duckdb.connect()
    try:
        for extension in DUCKDB_EXTENSIONS:
            connection.execute(f"LOAD {extension}")
        # No DATA_PATH: the catalog already records where its files live, and
        # passing a path that disagrees with it - a moved volume, a different
        # STORAGE_DIR - makes DuckLake refuse the attach outright. Maintenance
        # must work on the catalog as it is, not as this process is configured.
        connection.execute(
            f"ATTACH IF NOT EXISTS '{attach_string(catalog_url())}' AS {ATTACH_ALIAS} "
            f"(METADATA_SCHEMA '{metadata}')"
        )

        # dbt's own leftovers first: dropping them is what makes their data
        # files unreferenced, so snapshot expiry can then release them.
        try:
            backups = connection.execute(
                "SELECT schema_name, table_name FROM duckdb_tables() "
                "WHERE database_name = ? AND table_name LIKE '%__dbt_backup'",
                [ATTACH_ALIAS],
            ).fetchall()
            for schema_name, table_name in backups:
                # Identifiers come from the catalog itself, never from a request.
                connection.execute(
                    f'DROP TABLE IF EXISTS {ATTACH_ALIAS}."{schema_name}"."{table_name}"'
                )
            results["drop_dbt_backups"] = f"dropped {len(backups)}"
        except Exception as exc:
            results["drop_dbt_backups"] = f"skipped: {exc}"

        for name, template in _MAINTENANCE_STEPS:
            statement = template.format(alias=ATTACH_ALIAS, days=int(retention_days))
            try:
                connection.execute(statement)
                results[name] = "ok"
            except Exception as exc:
                results[name] = f"skipped: {exc}"
    except Exception as exc:
        raise LakehouseError(f"could not maintain the lakehouse: {exc}") from exc
    finally:
        connection.close()

    logger.info("Lake maintenance for %s: %s", project_id, results)
    return results
