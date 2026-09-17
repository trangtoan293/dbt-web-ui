"""Resolving a `ducklake` connection row into a LakeRef, and validating one.

`ingest/lakehouse.py` owns the DuckLake layout and imports nothing from `app`,
so it cannot read the database. This module is the seam: it turns a
`connections` row into the LakeRef every lakehouse operation takes, and it is
where a user-supplied catalog is checked before anything attaches to it.

Two rules decide almost everything here:

  * A **managed** lake's location is never user input. Its catalog URL is read
    from settings at resolve time rather than copied into the row, so rotating
    LAKE_CATALOG_URL moves every managed lake with it instead of leaving rows
    pointing at a database that no longer exists.
  * An **external** lake's location is entirely user input, so it goes through
    host_guard and the path/identifier validators - at save time *and* again at
    resolve time. The second check is not redundant: host_guard resolves names
    to addresses, and a name that was safe when saved can be repointed later.
"""

import asyncio
import logging
import re
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import quote, urlparse

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.crypto import decrypt_secret_or_plaintext
from app.core.host_guard import assert_host_allowed
from ingest import lakehouse
from ingest.lakehouse import LakeRef, LakehouseError

logger = logging.getLogger(__name__)

CONNECTION_TYPE = "ducklake"

CATALOG_POSTGRES = "postgresql"
CATALOG_SQLITE = "sqlite"
CATALOG_TYPES = (CATALOG_POSTGRES, CATALOG_SQLITE)

_LAKE_COLUMNS = (
    "id, name, connection_type, host, port, database, username, "
    "password_encrypted, extra_config"
)


def _catalog_url_from_row(row: Dict[str, Any], password: str) -> str:
    """Build the catalog URL an external lake row describes."""
    extra = dict(row.get("extra_config") or {})
    catalog_type = extra.get("catalog_type") or CATALOG_POSTGRES
    database = str(row.get("database") or "")

    if catalog_type == CATALOG_SQLITE:
        # A sqlite catalog is one file path, which is how a lake on object
        # storage exists without anyone running a Postgres for it.
        if not database:
            raise LakehouseError("a sqlite catalog needs a file path")
        return f"sqlite:///{database.lstrip('/')}"

    host = str(row.get("host") or "")
    port = int(row.get("port") or 5432)
    user = str(row.get("username") or "")
    if not host or not database:
        raise LakehouseError("a postgres catalog needs a host and a database name")
    credentials = quote(user, safe="")
    if password:
        credentials = f"{credentials}:{quote(password, safe='')}"
    return f"postgresql://{credentials}@{host}:{port}/{database}"


async def _assert_catalog_host_allowed(catalog_url: str) -> None:
    """Refuse a catalog aimed at this deployment's own infrastructure.

    Without this a user points a lakehouse at the application's Postgres, dbt
    attaches it, and every other user's `connections.password_encrypted` is
    readable through ordinary model SQL. Managed lakes never reach here - their
    URL comes from settings, and settings *is* the deployment's own database.
    """
    parsed = urlparse(catalog_url)
    if parsed.scheme.split("+")[0] in ("sqlite", "file", ""):
        return
    if not parsed.hostname:
        raise LakehouseError("the lakehouse catalog URL has no host")
    await asyncio.to_thread(assert_host_allowed, parsed.hostname, parsed.port)


def lake_ref_from_row(row: Dict[str, Any], *, password: Optional[str] = None) -> LakeRef:
    """Turn a `connections` row of type ducklake into a LakeRef.

    Does not reach the network: the host check is async and lives in
    `resolve_lake`, which is the only path a request takes.
    """
    extra = dict(row.get("extra_config") or {})
    mode = extra.get("mode") or lakehouse.MODE_MANAGED
    if mode not in lakehouse.MODES:
        raise LakehouseError(f"unknown lakehouse mode '{mode}'")

    if mode == lakehouse.MODE_MANAGED:
        # Location from settings, never from the row: see the module docstring.
        catalog = lakehouse.catalog_url()
        defaults = lakehouse.managed_defaults(str(row["id"]))
        return LakeRef(
            catalog_url=catalog,
            data_path=str(extra.get("data_path") or defaults["data_path"]),
            metadata_schema=lakehouse.validate_metadata_schema(
                str(extra.get("metadata_schema") or defaults["metadata_schema"])
            ),
            mode=lakehouse.MODE_MANAGED,
            maintained=bool(extra.get("maintained", True)),
        )

    secret = (
        password
        if password is not None
        else decrypt_secret_or_plaintext(row.get("password_encrypted"))
    )
    return LakeRef(
        catalog_url=_catalog_url_from_row(row, secret),
        data_path=lakehouse.validate_data_path(str(extra.get("data_path") or "")),
        metadata_schema=lakehouse.validate_metadata_schema(
            str(extra.get("metadata_schema") or "")
        ),
        mode=lakehouse.MODE_EXTERNAL,
        # External defaults to unmaintained: somebody else's garbage collector
        # already runs on this catalog, and two of them cannot share files.
        maintained=bool(extra.get("maintained", False)),
    )


async def resolve_lake(
    session: AsyncSession, connection_id: str, *, owner: Optional[str] = None
) -> Optional[LakeRef]:
    """Load one lakehouse connection and check it is safe to attach."""
    clause = "id = CAST(:cid AS uuid)"
    params: Dict[str, Any] = {"cid": str(connection_id)}
    if owner:
        clause += " AND created_by = CAST(:uid AS uuid)"
        params["uid"] = str(owner)

    result = await session.execute(
        text(f"SELECT {_LAKE_COLUMNS} FROM connections WHERE {clause}"), params
    )
    row = result.mappings().first()
    if not row or row["connection_type"] != CONNECTION_TYPE:
        return None

    lake = lake_ref_from_row(dict(row))
    if not lake.managed:
        await _assert_catalog_host_allowed(lake.catalog_url)
    return lake


async def resolve_project_lake(
    session: AsyncSession, project_id: str
) -> Optional[LakeRef]:
    """The lakehouse a project is attached to, if it has one.

    Returns None rather than raising when the project has no lake: most projects
    do not, and a dbt run must not fail over a feature this one does not use.
    A lake that *is* attached but cannot be resolved does raise - silently
    dropping the attach would make every model referencing `lake.*` fail with
    "not found within 'lake'", which reads as the connection having reverted.
    """
    result = await session.execute(
        text(
            "SELECT lakehouse_connection_id FROM dbt_projects "
            "WHERE id = CAST(:pid AS uuid)"
        ),
        {"pid": str(project_id)},
    )
    connection_id = result.scalar()
    if not connection_id:
        return None
    lake = await resolve_lake(session, str(connection_id))
    if lake is None:
        raise LakehouseError(
            "the lakehouse attached to this project no longer exists - attach an "
            "existing lakehouse in Project Settings"
        )
    return lake


async def projects_using_lake(session: AsyncSession, connection_id: str) -> list:
    """Live projects attached to this lake, newest first."""
    result = await session.execute(
        text(
            "SELECT id, name FROM dbt_projects "
            "WHERE lakehouse_connection_id = CAST(:cid AS uuid) "
            "AND deleted_at IS NULL ORDER BY created_at DESC"
        ),
        {"cid": str(connection_id)},
    )
    return [{"id": str(r["id"]), "name": r["name"]} for r in result.mappings().all()]


async def validate_lake_payload(
    extra_config: Dict[str, Any],
    *,
    host: str = "",
    port: Optional[int] = None,
    database: str = "",
    username: str = "",
    password: str = "",
    connection_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Normalise and check what the connection form submitted for a lakehouse.

    Returns the `extra_config` to store. Raises LakehouseError or HostNotAllowed
    with a message meant for the person who typed it.

    A managed lake ignores everything the form sent about location - there is
    nothing for a user to choose, and accepting a value here would be the one
    way to make a managed lake point somewhere it should not.
    """
    extra = dict(extra_config or {})
    mode = extra.get("mode") or lakehouse.MODE_MANAGED
    if mode not in lakehouse.MODES:
        raise LakehouseError(
            f"unknown lakehouse mode '{mode}': use "
            f"'{lakehouse.MODE_MANAGED}' or '{lakehouse.MODE_EXTERNAL}'"
        )

    if mode == lakehouse.MODE_MANAGED:
        if not lakehouse.is_configured():
            raise LakehouseError(
                "no lakehouse catalog is configured for this deployment - set "
                "LAKE_CATALOG_URL, or connect to an existing lakehouse instead"
            )
        stored = {"mode": lakehouse.MODE_MANAGED, "maintained": True}
        if connection_id:
            stored.update(lakehouse.managed_defaults(str(connection_id)))
        return stored

    catalog_type = extra.get("catalog_type") or CATALOG_POSTGRES
    if catalog_type not in CATALOG_TYPES:
        raise LakehouseError(
            f"unknown catalog type '{catalog_type}': use "
            f"'{CATALOG_POSTGRES}' or '{CATALOG_SQLITE}'"
        )

    stored = {
        "mode": lakehouse.MODE_EXTERNAL,
        "catalog_type": catalog_type,
        "metadata_schema": lakehouse.validate_metadata_schema(
            str(extra.get("metadata_schema") or "")
        ),
        "data_path": lakehouse.validate_data_path(str(extra.get("data_path") or "")),
        "maintained": bool(extra.get("maintained", False)),
    }

    row = {
        "host": host,
        "port": port,
        "database": database,
        "username": username,
        "extra_config": stored,
    }
    catalog_url = _catalog_url_from_row(row, password)
    await _assert_catalog_host_allowed(catalog_url)
    return stored


async def test_lake(lake: LakeRef) -> Dict[str, Any]:
    """Reach a lakehouse and report what is in it.

    An external lake is checked for existence *before* attaching. Attaching
    creates the metadata schema when it is absent, so a typo in the schema name
    would leave a stray empty catalog in somebody else's database and report
    success - the one failure mode where "it worked" is worse than an error.
    """
    if not lake.managed and not await asyncio.to_thread(lakehouse.catalog_exists, lake):
        return {
            "success": False,
            "message": (
                f"No DuckLake catalog found in schema '{lake.metadata_schema}'. "
                "Check the schema name - connecting would otherwise create an "
                "empty catalog there."
            ),
        }

    def _probe() -> Dict[str, Any]:
        connection = lakehouse._connect(lake, with_data_path=lake.managed)
        try:
            tables = connection.execute(
                "SELECT count(*) FROM duckdb_tables() WHERE database_name = ?",
                [lakehouse.ATTACH_ALIAS],
            ).fetchone()
            schemas = connection.execute(
                "SELECT count(*) FROM duckdb_schemas() WHERE database_name = ?",
                [lakehouse.ATTACH_ALIAS],
            ).fetchone()
            return {
                "tables": int(tables[0]) if tables else 0,
                "schemas": int(schemas[0]) if schemas else 0,
            }
        finally:
            connection.close()

    try:
        counts = await asyncio.to_thread(_probe)
    except Exception as exc:
        return {"success": False, "message": str(exc)}

    return {
        "success": True,
        "message": f"Connected to the lakehouse ({counts['tables']} tables)",
        "details": {
            "mode": lake.mode,
            "metadata_schema": lake.metadata_schema,
            "data_path": lake.data_path,
            "maintained": lake.maintained,
            **counts,
        },
    }


# --- Materialising into the lake -------------------------------------------
#
# `+database: lake` in dbt_project.yml is what makes dbt build models *into* the
# lake instead of the warehouse file it opened. Without it a project ingests
# into the lake, reads it happily, and then writes its marts somewhere else -
# which looks exactly like the marts going missing. It has never been settable
# from the UI, so the only projects that had it were the ones someone edited by
# hand.

_MODELS_KEY_RE = re.compile(r"^models:\s*$")
_LAKE_DATABASE_LINE_RE = re.compile(
    rf"""^\s*\+?database:\s*['"]?{lakehouse.ATTACH_ALIAS}['"]?\s*$"""
)


def _project_yml(project_path: Path) -> Path:
    return Path(project_path) / "dbt_project.yml"


def builds_into_lake(project_path: Path) -> bool:
    """Whether dbt_project.yml pins models at the lake catalog."""
    path = _project_yml(project_path)
    try:
        content = path.read_text()
    except OSError:
        return False
    return any(_LAKE_DATABASE_LINE_RE.match(line) for line in content.splitlines())


def set_builds_into_lake(project_path: Path, enabled: bool) -> bool:
    """Add or remove `+database: lake` under the project's `models:` key.

    A line edit rather than a YAML round trip: dbt_project.yml ships full of
    comments explaining each key, and safe_load/safe_dump would silently delete
    every one of them the first time somebody ticked a checkbox.

    Returns whether the file changed.
    """
    path = _project_yml(project_path)
    try:
        lines = path.read_text().splitlines(keepends=True)
    except OSError as exc:
        raise LakehouseError(f"could not read dbt_project.yml: {exc}") from exc

    kept = [line for line in lines if not _LAKE_DATABASE_LINE_RE.match(line.rstrip("\n"))]
    removed = len(kept) != len(lines)

    if not enabled:
        if not removed:
            return False
        path.write_text("".join(kept))
        return True

    if removed:
        # It was already there; rewriting it in the canonical place is still the
        # right outcome, but nothing changed for the user.
        lines = kept

    # The first key under `models:` is the project's own name. Anything nested
    # deeper (staging:, marts:) inherits from it, which is why the pin belongs
    # exactly there and not at the top of the block.
    for index, line in enumerate(lines):
        if not _MODELS_KEY_RE.match(line.rstrip("\n")):
            continue
        for offset in range(index + 1, len(lines)):
            candidate = lines[offset]
            stripped = candidate.strip()
            if not stripped or stripped.startswith("#"):
                continue
            indent = len(candidate) - len(candidate.lstrip())
            if indent == 0:
                break  # `models:` had no children; fall through to the error
            lines.insert(offset + 1, f"{' ' * (indent + 2)}+database: {lakehouse.ATTACH_ALIAS}\n")
            path.write_text("".join(lines))
            return True
        break

    raise LakehouseError(
        "dbt_project.yml has no `models:` block naming this project, so there is "
        "nowhere to pin the lakehouse. Add one, or set `+database: lake` by hand."
    )
