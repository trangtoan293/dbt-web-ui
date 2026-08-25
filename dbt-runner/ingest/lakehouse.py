"""DuckLake lakehouse layout, shared by the ingest runner and dbt profiles.

The catalog is a set of metadata tables in a SQL database; the data files are
Parquet on the storage volume. Both dlt (writing raw tables) and dbt (reading
them, writing marts) must attach *the same* catalog, which means agreeing on the
metadata schema. They do not agree by default: dlt derives the metadata schema
from the DuckLake name while dbt-duckdb attaches into `public`, which silently
produces two independent catalogs over one data directory - ingest reports
success and dbt then fails with `schema ... does not exist`. Every attach in
this codebase therefore goes through a LakeRef built here.

A lake is a `connections` row of type `ducklake`, in one of two modes:

    managed  - this deployment created the catalog and owns its files. The
               catalog URL comes from LAKE_CATALOG_URL and the schema and data
               directory are derived from the connection id, so nothing about
               its location is user input.
    external - the catalog belongs to someone else. Every locating value is
               typed by a user, so every one of them is validated here, and
               nothing that changes the catalog's global behaviour or deletes
               its files may run against it.

The mode is not a display flag: `provision()` refuses to pin write options on an
external lake and `destroy()` refuses to touch one at all, because those are the
two operations that damage a catalog somebody else depends on.

ponytail: one alias, so one lake per project. The alias `lake` is a constant in
every model's SQL; a second lake would have to be named, which changes how
models are written. Add it when a project actually needs two.
"""

import logging
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional
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

MODE_MANAGED = "managed"
MODE_EXTERNAL = "external"
MODES = (MODE_MANAGED, MODE_EXTERNAL)

_UUID_CHARS = re.compile(r"[^a-z0-9]")

# A metadata schema name is concatenated into DDL (`ATTACH ... METADATA_SCHEMA
# '...'`), where a bound parameter is not accepted. Derived names have always
# been safe; an external lake's name is typed by a user, so it is validated to
# the shape Postgres accepts for an unquoted identifier and nothing else.
_SCHEMA_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,62}$")


class LakehouseError(RuntimeError):
    """Raised when the lake cannot be located or provisioned."""


@dataclass(frozen=True)
class LakeRef:
    """Everything needed to attach one DuckLake catalog.

    Immutable on purpose: it is passed to maintenance and to a subprocess
    runner, and a caller that could edit the mode could turn an external lake
    into one this deployment believes it owns.
    """

    catalog_url: str
    data_path: str
    metadata_schema: str
    mode: str = MODE_MANAGED
    maintained: bool = True

    @property
    def managed(self) -> bool:
        return self.mode == MODE_MANAGED

    def as_job_config(self) -> Dict[str, Any]:
        """Plain JSON for the ingest runner, which is configured over stdin."""
        return {
            "catalog_url": self.catalog_url,
            "data_path": self.data_path,
            "metadata_schema": self.metadata_schema,
            "mode": self.mode,
            "ducklake_name": ATTACH_ALIAS,
        }

    @classmethod
    def from_job_config(cls, config: Dict[str, Any]) -> "LakeRef":
        return cls(
            catalog_url=config["catalog_url"],
            data_path=config["data_path"],
            metadata_schema=config["metadata_schema"],
            mode=config.get("mode") or MODE_MANAGED,
        )


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


def catalog_url() -> str:
    """Configured catalog URL, as dlt's DuckLake catalog credentials expect."""
    url = _configured_catalog_url()
    if not url:
        raise LakehouseError(
            "LAKE_CATALOG_URL (or DATABASE_URL) must be set to use a lakehouse destination"
        )
    return url


def catalog_password(url: Optional[str] = None) -> str:
    return urlparse(url or catalog_url()).password or ""


def metadata_schema(lake_id: str) -> str:
    """Metadata schema for a managed lake with this id.

    Keyed by the lake's own id rather than a project's, which is what lets
    several projects share one lake. Existing deployments keep the schema they
    already have: the migration stores the literal name it computed from the
    project id, so this function's input never has to match history.
    """
    slug = _UUID_CHARS.sub("", str(lake_id).lower())
    if not slug:
        raise LakehouseError("lake id is not a usable catalog name")
    # Postgres identifiers cap at 63 bytes and DuckLake appends to this name.
    return f"lake_{slug[:24]}"


def data_dir(lake_id: str) -> Path:
    """Directory holding a managed lake's Parquet files."""
    base = settings.lake_data_dir or str(Path(settings.storage_dir) / "lake")
    slug = _UUID_CHARS.sub("", str(lake_id).lower())
    if not slug:
        raise LakehouseError("lake id is not a usable data path")
    return Path(base) / slug


def managed_defaults(lake_id: str) -> Dict[str, str]:
    """Where a newly created managed lake lives. No user input involved."""
    return {
        "data_path": f"{data_dir(lake_id)}",
        "metadata_schema": metadata_schema(lake_id),
    }


def validate_metadata_schema(name: str) -> str:
    """Accept only what can be concatenated into DDL as an identifier."""
    candidate = (name or "").strip()
    if not _SCHEMA_RE.match(candidate):
        raise LakehouseError(
            f"invalid metadata schema '{name}': use a letter or underscore "
            "followed by letters, digits, _ or $ (max 63 characters)"
        )
    return candidate


def _is_object_storage(path: str) -> bool:
    return bool(re.match(r"^[a-z0-9+.-]+://", path or "", re.IGNORECASE))


def validate_data_path(path: str) -> str:
    """Accept an external lake's data path only where policy allows it.

    Two separate refusals, for two separate attacks. A path inside this
    deployment's own lake directory would let one user read and overwrite
    another's managed lake, so it is refused regardless of configuration.
    Anywhere else on the local filesystem is refused unless an operator listed
    a root in LAKE_EXTERNAL_DATA_ROOTS, because dbt-runner can write anywhere
    its uid can reach.

    Object storage (s3://, gs://, az://) passes: it carries no local path to
    escape from, and it is how a shared lake usually exists.
    """
    candidate = (path or "").strip()
    if not candidate:
        raise LakehouseError("a lakehouse data path is required")

    if _is_object_storage(candidate):
        return candidate

    resolved = Path(candidate).resolve()

    own = Path(settings.lake_data_dir or str(Path(settings.storage_dir) / "lake")).resolve()
    if resolved == own or own in resolved.parents:
        raise LakehouseError(
            f"'{path}' is inside this deployment's own lake directory. That space "
            "belongs to lakehouses created here - point an external lakehouse at "
            "its own storage."
        )

    roots = [r.strip() for r in (settings.lake_external_data_roots or "").split(",") if r.strip()]
    if not roots:
        raise LakehouseError(
            f"'{path}' is a local path, and no external lakehouse roots are "
            "configured. Set LAKE_EXTERNAL_DATA_ROOTS to the mount points an "
            "external lakehouse may use, or give an object-storage URL."
        )
    for root in roots:
        allowed = Path(root).resolve()
        if resolved == allowed or allowed in resolved.parents:
            return str(resolved)

    raise LakehouseError(
        f"'{path}' is not under any configured external lakehouse root "
        f"({', '.join(roots)})"
    )


def attach_string(url: str, *, password: Optional[str] = None) -> str:
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


def dbt_attach_entry(lake: LakeRef) -> dict:
    """The `attach:` entry for a dbt-duckdb profile pointing at this lake."""
    return {
        "path": attach_string(
            lake.catalog_url, password=f"{{{{ env_var('{CATALOG_PASSWORD_ENV}') }}}}"
        ),
        "alias": ATTACH_ALIAS,
        "is_ducklake": True,
        "options": {
            "data_path": f"{str(lake.data_path).rstrip('/')}/",
            "metadata_schema": lake.metadata_schema,
        },
    }


def _connect(lake: LakeRef, *, with_data_path: bool = False, install: bool = False):
    """Open a DuckDB connection with this lake attached.

    `with_data_path` only on the first attach of a managed lake: the catalog
    records where its files live, and passing a path that disagrees with it - a
    moved volume, a different STORAGE_DIR - makes DuckLake refuse the attach
    outright. Every later attach must work on the catalog as it is, not as this
    process is configured.
    """
    import duckdb

    connection = duckdb.connect()
    try:
        for extension in DUCKDB_EXTENSIONS:
            if install:
                connection.execute(f"INSTALL {extension}")
            connection.execute(f"LOAD {extension}")
        options = [f"METADATA_SCHEMA '{validate_metadata_schema(lake.metadata_schema)}'"]
        if with_data_path:
            options.insert(0, f"DATA_PATH '{str(lake.data_path).rstrip('/')}/'")
        connection.execute(
            f"ATTACH IF NOT EXISTS '{attach_string(lake.catalog_url)}' "
            f"AS {ATTACH_ALIAS} ({', '.join(options)})"
        )
    except Exception:
        connection.close()
        raise
    return connection


def catalog_exists(lake: LakeRef) -> bool:
    """Whether this catalog already has DuckLake's metadata tables.

    Used before attaching an external lake: attaching creates the schema when
    absent, so a typo in the schema name would leave a stray empty catalog in
    somebody else's database and report success.
    """
    parsed = urlparse(lake.catalog_url)
    scheme = parsed.scheme.split("+")[0]
    schema = validate_metadata_schema(lake.metadata_schema)

    if scheme in ("sqlite", "file", ""):
        # A sqlite catalog is one file; its absence is the whole answer.
        return Path(parsed.path or lake.catalog_url).exists()

    import duckdb

    connection = duckdb.connect()
    try:
        connection.execute("LOAD postgres")
        connection.execute(
            f"ATTACH '{_postgres_attach_string(lake.catalog_url)}' AS cat (TYPE postgres, READ_ONLY)"
        )
        rows = connection.execute(
            "SELECT count(*) FROM cat.information_schema.tables "
            "WHERE table_schema = ? AND table_name = 'ducklake_snapshot'",
            [schema],
        ).fetchone()
        return bool(rows and rows[0])
    except Exception as exc:
        raise LakehouseError(f"could not reach the lakehouse catalog: {exc}") from exc
    finally:
        connection.close()


def _postgres_attach_string(url: str) -> str:
    """A plain postgres ATTACH string, for inspecting a catalog database."""
    parsed = urlparse(url)
    database = parsed.path.lstrip("/")
    if not parsed.hostname or not database:
        raise LakehouseError("lakehouse catalog URL is missing a host or database name")
    return (
        f"dbname={database} host={parsed.hostname} port={parsed.port or 5432} "
        f"user={parsed.username or ''} password={parsed.password or ''}"
    )


def provision(lake: LakeRef, *, inline_row_limit: Optional[int] = None) -> None:
    """Create a managed lake's catalog and pin its write behaviour.

    Idempotent: safe to call before every load. Attaching creates the metadata
    schema when absent; the inlining limit is stored in the catalog itself, so
    one call covers every later writer, dlt and dbt alike.

    An external lake gets neither. `set_option` writes to `ducklake_metadata`,
    which changes how *every* client of that catalog writes - including its
    owner's - so it is not ours to set. The attach still happens, because a
    writer has to attach; it just creates nothing and pins nothing.
    """
    if not lake.managed:
        logger.debug(
            "Skipping provision for external lake (schema=%s)", lake.metadata_schema
        )
        return

    directory: Optional[Path] = None
    if not _is_object_storage(lake.data_path):
        directory = Path(lake.data_path)
        directory.mkdir(parents=True, exist_ok=True)

    limit = (
        settings.lake_inline_row_limit if inline_row_limit is None else inline_row_limit
    )

    try:
        connection = _connect(lake, with_data_path=True, install=True)
    except Exception as exc:  # duckdb raises a wide range of catalog errors
        raise LakehouseError(f"could not provision the lakehouse: {exc}") from exc
    try:
        connection.execute(
            f"CALL {ATTACH_ALIAS}.set_option('data_inlining_row_limit', {int(limit)})"
        )
    except Exception as exc:
        raise LakehouseError(f"could not provision the lakehouse: {exc}") from exc
    finally:
        connection.close()

    logger.info(
        "Provisioned lake (schema=%s data=%s inlining=%s)",
        lake.metadata_schema,
        directory or lake.data_path,
        limit,
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
    lake: LakeRef,
    *,
    dataset: str,
    tables: list,
    partition_by: list,
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

    Partitioning a table is a property of the table, not of the catalog, so it
    is allowed on an external lake - the caller only ever names tables its own
    ingest job just wrote.
    """
    expressions = [partition_expression(term) for term in partition_by if str(term).strip()]
    if not expressions:
        return {}

    results: dict = {}
    try:
        connection = _connect(lake)
    except Exception as exc:
        raise LakehouseError(f"could not partition the lakehouse tables: {exc}") from exc
    try:
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


# A table with many files and no partition spec is read in full on every query
# that filters it. Reported rather than fixed: only the person who wrote the
# model knows which column the filters use, and guessing wrong costs a rewrite.
_UNPARTITIONED_MIN_FILES = 4

_UNPARTITIONED_QUERY = """
SELECT t.table_name, i.file_count
FROM ducklake_table_info('{alias}') i
JOIN __ducklake_metadata_{alias}.ducklake_table t ON t.table_id = i.table_id
LEFT JOIN (
    SELECT DISTINCT table_id
    FROM __ducklake_metadata_{alias}.ducklake_partition_info
    WHERE end_snapshot IS NULL
) p ON p.table_id = i.table_id
WHERE p.table_id IS NULL
  AND i.file_count >= {min_files}
  AND t.table_name NOT LIKE '%__dbt_backup'
ORDER BY i.file_count DESC
"""


def unpartitioned_tables(connection, *, min_files: int = _UNPARTITIONED_MIN_FILES) -> list:
    """Lake tables with no partition spec, worst first.

    Ingest sources can carry a partition spec; a table dbt built cannot - dbt
    creates it, so nothing in this codebase gets to choose its layout. The result
    is that marts, the most-queried tables in the lake, are the ones most likely
    to be scanned whole. Surfacing them is the honest half of the fix: the other
    half is a `post_hook` in the model, which only its author can write.

    Returns [(table_name, file_count)]. Never raises: the query reads DuckLake's
    internal metadata tables, whose names depend on the extension version.
    """
    try:
        rows = connection.execute(
            _UNPARTITIONED_QUERY.format(alias=ATTACH_ALIAS, min_files=int(min_files))
        ).fetchall()
        return [(str(name), int(count)) for name, count in rows]
    except Exception as exc:
        logger.debug("Could not list unpartitioned lake tables: %s", exc)
        return []


def maintain(lake: LakeRef, *, retention_days: int) -> dict:
    """Expire old snapshots, drop dbt's backup tables, and delete dead files.

    DuckLake keeps every snapshot and dbt-duckdb leaves `__dbt_backup` tables
    behind, so an ingesting lake's storage only ever grows. Called from the
    scheduler, once per lake this deployment maintains.

    Refuses a lake we do not maintain rather than letting the caller decide:
    `cleanup_old_files` and `delete_orphaned_files` delete every file this
    catalog does not reference, and on a lake somebody else also writes to,
    "unreferenced by us" is not the same as "garbage".

    Blocking (duckdb is synchronous) - call it in a thread. Returns one entry
    per step so a partial success is visible rather than silent.
    """
    if retention_days < 0:
        raise LakehouseError("retention_days cannot be negative")
    if not lake.maintained:
        raise LakehouseError(
            "this lakehouse is not maintained by this deployment - its owner runs "
            "its garbage collection"
        )

    results: dict = {}
    try:
        connection = _connect(lake)
    except Exception as exc:
        raise LakehouseError(f"could not maintain the lakehouse: {exc}") from exc
    try:
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

        # After merging: a table that still has many files is one whose scans
        # cannot be pruned, and compaction will not fix that.
        unpartitioned = unpartitioned_tables(connection)
        if unpartitioned:
            results["unpartitioned"] = ", ".join(
                f"{table} ({files} files)" for table, files in unpartitioned[:10]
            )
            logger.warning(
                "Lake tables with no partition spec in %s: %s. A query "
                "filtering these reads every file. Add a partition spec - for a "
                "dbt model, a post_hook running ALTER TABLE ... SET PARTITIONED BY.",
                lake.metadata_schema,
                results["unpartitioned"],
            )
    except Exception as exc:
        raise LakehouseError(f"could not maintain the lakehouse: {exc}") from exc
    finally:
        connection.close()

    logger.info("Lake maintenance for %s: %s", lake.metadata_schema, results)
    return results


def destroy(lake: LakeRef) -> dict:
    """Drop a managed lake's catalog schema and delete its Parquet.

    Refuses an external lake outright. This is the one operation whose blast
    radius is somebody else's data, so the check lives here rather than in the
    router: a caller cannot forget a guard it does not have to write.

    Both steps are attempted and reported. A schema that drops while the files
    fail to delete leaves orphaned Parquet, which is recoverable; the reverse is
    a catalog pointing at files that are gone, which is not - so files go last.
    """
    if not lake.managed:
        raise LakehouseError(
            "refusing to delete an external lakehouse: its catalog and files "
            "belong to whoever created it"
        )

    results: dict = {}
    schema = validate_metadata_schema(lake.metadata_schema)

    import duckdb

    connection = duckdb.connect()
    try:
        connection.execute("LOAD postgres")
        parsed = urlparse(lake.catalog_url)
        if parsed.scheme.split("+")[0] in ("postgres", "postgresql"):
            connection.execute(
                f"ATTACH '{_postgres_attach_string(lake.catalog_url)}' AS cat (TYPE postgres)"
            )
            connection.execute(f'DROP SCHEMA IF EXISTS cat."{schema}" CASCADE')
            results["drop_schema"] = "ok"
        else:
            results["drop_schema"] = "skipped: not a postgres catalog"
    except Exception as exc:
        results["drop_schema"] = f"failed: {exc}"
    finally:
        connection.close()

    if _is_object_storage(lake.data_path):
        results["delete_files"] = "skipped: object storage"
    else:
        try:
            shutil.rmtree(lake.data_path, ignore_errors=True)
            results["delete_files"] = "ok"
        except Exception as exc:
            results["delete_files"] = f"failed: {exc}"

    logger.info("Destroyed lake %s: %s", schema, results)
    return results
