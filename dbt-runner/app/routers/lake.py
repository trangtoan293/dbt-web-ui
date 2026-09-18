"""Lakehouse router: publish a project's lake marts as Iceberg tables.

The lake itself is written by dbt and by ingest. This is the way out of it: an
Iceberg copy of a schema, so engines that cannot read DuckLake - which today is
all of them except DuckDB - can read the marts.
"""

import asyncio
import logging
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_user, resolve_user_id
from app.core.db import get_session
from app.core.dependencies import get_project_service
from app.services.project import ProjectService
from app.core.host_guard import HostNotAllowed
from app.services import lakes
from app.services.lakes import resolve_project_lake
from ingest import iceberg, lakehouse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Lakehouse"])

# A schema or table name here becomes part of a SQL statement and of a directory
# path, so it is validated rather than quoted.
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,62}$")


class IcebergPublishRequest(BaseModel):
    schema_name: str = Field(
        default="marts",
        alias="schema",
        description="Lake schema to publish, e.g. the one dbt builds marts into",
    )
    tables: Optional[List[str]] = Field(
        default=None, description="Subset to publish; omit for every table in the schema"
    )

    model_config = {"populate_by_name": True}


async def _owned_project(session: AsyncSession, project_id: str, user_id: str) -> None:
    """Refuse a project the caller does not own, as the file endpoints do."""
    result = await session.execute(
        text(
            "SELECT 1 FROM dbt_projects "
            "WHERE id = CAST(:pid AS uuid) AND created_by = CAST(:uid AS uuid) "
            "AND deleted_at IS NULL"
        ),
        {"pid": project_id, "uid": user_id},
    )
    if result.first() is None:
        raise HTTPException(status_code=403, detail="Project not found or not yours")


@router.get("/lake/iceberg/meta")
async def iceberg_meta() -> Dict[str, Any]:
    """Whether this deployment can publish Iceberg, and where it lands."""
    return {
        "configured": iceberg.is_configured(),
        "lakehouse_configured": lakehouse.is_configured(),
    }


@router.post("/lake/iceberg/{project_id}")
async def publish_iceberg(
    project_id: str,
    request: IcebergPublishRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> Dict[str, Any]:
    """Bring this project's Iceberg tables in step with a lake schema.

    A table the lake only appended to is published incrementally - just the new
    Parquet is copied. A table dbt rebuilt, or one whose files lake maintenance
    rewrote, is replaced: there is no honest delta for a file set that is not a
    superset of what was published.
    """
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _owned_project(session, project_id, user_id)

    if not iceberg.is_configured():
        raise HTTPException(
            status_code=400,
            detail="Iceberg publishing is not configured on this deployment "
            "(needs a lakehouse catalog; see ICEBERG_CATALOG_URL)",
        )
    if not _NAME_RE.match(request.schema_name):
        raise HTTPException(status_code=400, detail="Invalid schema name")
    for table in request.tables or []:
        if not _NAME_RE.match(table):
            raise HTTPException(status_code=400, detail=f"Invalid table name: {table}")

    try:
        # Blocking: duckdb, pyiceberg and the file copy are all synchronous, and
        # a mart can be large enough that this runs for minutes.
        lake = await resolve_project_lake(session, project_id)
        if lake is None:
            raise HTTPException(
                status_code=400,
                detail="This project has no lakehouse attached, so there is "
                "nothing to publish. Attach one in Project Settings.",
            )
        result = await asyncio.to_thread(
            iceberg.publish,
            project_id,
            lake,
            schema=request.schema_name,
            tables=request.tables,
        )
    except (iceberg.IcebergPublishError, lakehouse.LakehouseError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Iceberg publish failed for %s", project_id)
        raise HTTPException(status_code=500, detail=f"Publish failed: {exc}") from exc

    return {"success": True, **result}


# --- Lakehouse connections -------------------------------------------------
#
# A lakehouse is a `connections` row of type `ducklake`, created and deleted by
# the frontend like any other connection. Everything that has to be *checked*
# about one lives here, because the checks need the deployment's own settings
# and the host guard: a lakehouse the frontend saved without asking would be a
# user-supplied database URL nobody validated.


class LakehouseCheckRequest(BaseModel):
    mode: str = Field(default=lakehouse.MODE_MANAGED)
    catalog_type: str = Field(default=lakes.CATALOG_POSTGRES, alias="catalogType")
    host: str = ""
    port: Optional[int] = None
    database: str = ""
    username: str = ""
    password: str = ""
    data_path: str = Field(default="", alias="dataPath")
    metadata_schema: str = Field(default="", alias="metadataSchema")
    maintained: Optional[bool] = None
    connection_id: Optional[str] = Field(default=None, alias="connectionId")
    probe: bool = True

    model_config = {"populate_by_name": True}


@router.post("/lakehouse/check")
async def check_lakehouse(
    request: LakehouseCheckRequest,
    claims: dict = Depends(require_user),
) -> Dict[str, Any]:
    """Validate a lakehouse the connection form is about to save, and reach it.

    Returns the `extra_config` to store, so the frontend never composes those
    values itself - a managed lake's location in particular is generated here
    and ignored from the request, which is what keeps "managed" meaning
    "this deployment chose where it lives".

    `probe: false` skips the connectivity check, for a save that only needs the
    payload validated.
    """
    extra: Dict[str, Any] = {
        "mode": request.mode,
        "catalog_type": request.catalog_type,
        "data_path": request.data_path,
        "metadata_schema": request.metadata_schema,
    }
    if request.maintained is not None:
        extra["maintained"] = request.maintained

    try:
        stored = await lakes.validate_lake_payload(
            extra,
            host=request.host,
            port=request.port,
            database=request.database,
            username=request.username,
            password=request.password,
            connection_id=request.connection_id,
        )
    except HostNotAllowed as exc:
        return {"success": False, "message": str(exc)}
    except lakehouse.LakehouseError as exc:
        return {"success": False, "message": str(exc)}

    if not request.probe:
        return {"success": True, "extraConfig": stored, "message": "Looks valid"}

    row = {
        "id": request.connection_id or "00000000-0000-4000-8000-000000000000",
        "host": request.host,
        "port": request.port,
        "database": request.database,
        "username": request.username,
        "extra_config": stored,
    }
    try:
        lake = lakes.lake_ref_from_row(row, password=request.password)
    except lakehouse.LakehouseError as exc:
        return {"success": False, "message": str(exc)}

    result = await lakes.test_lake(lake)
    return {**result, "extraConfig": stored}


@router.delete("/lakehouse/{connection_id}")
async def delete_lakehouse(
    connection_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> Dict[str, Any]:
    """Release a lakehouse before its connection row is deleted.

    Refuses while any project still points at it: dropping the catalog out from
    under a project turns every model referencing `lake.*` into a failure whose
    cause is nowhere on screen.

    A managed lake's catalog schema and Parquet are then deleted, because this
    deployment created them and nothing else will. An external lake is only
    forgotten - `lakehouse.destroy` refuses it outright, so this route cannot
    delete somebody else's data even if it is called for one.
    """
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    lake = await lakes.resolve_lake(session, connection_id, owner=user_id)
    if lake is None:
        raise HTTPException(status_code=404, detail="Lakehouse not found or not yours")

    in_use = await lakes.projects_using_lake(session, connection_id)
    if in_use:
        names = ", ".join(p["name"] for p in in_use[:5])
        raise HTTPException(
            status_code=409,
            detail=f"This lakehouse is attached to {len(in_use)} project(s): {names}. "
            "Detach it in Project Settings first.",
        )

    if not lake.managed:
        return {"success": True, "destroyed": False, "detail": "external lakehouse left untouched"}

    result = await asyncio.to_thread(lakehouse.destroy, lake)
    return {"success": True, "destroyed": True, "steps": result}


@router.get("/lakehouse/{connection_id}/usage")
async def lakehouse_usage(
    connection_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> Dict[str, Any]:
    """Projects attached to this lakehouse, for the delete confirmation."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    lake = await lakes.resolve_lake(session, connection_id, owner=user_id)
    if lake is None:
        raise HTTPException(status_code=404, detail="Lakehouse not found or not yours")
    return {
        "mode": lake.mode,
        "maintained": lake.maintained,
        "metadataSchema": lake.metadata_schema,
        "dataPath": lake.data_path,
        "projects": await lakes.projects_using_lake(session, connection_id),
    }


# --- A project's lakehouse -------------------------------------------------


class ProjectLakehouseRequest(BaseModel):
    connection_id: Optional[str] = Field(default=None, alias="connectionId")
    build_into_lake: Optional[bool] = Field(default=None, alias="buildIntoLake")

    model_config = {"populate_by_name": True}


def _warehouse_supports_lake(record: Any) -> bool:
    """Whether this project's dbt profile can attach a DuckLake catalog."""
    row = record or {}
    warehouse_type = row.get("warehouse_type")
    if warehouse_type is not None:
        return warehouse_type == "duckdb"
    # No warehouse row: a placeholder DuckDB profile, unless the project runs on
    # a Dremio source instead, which has no row in `connections` either.
    return not row.get("dremio_source_id")


@router.get("/lakehouse/project/{project_id}")
async def get_project_lakehouse(
    project_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    project_service: ProjectService = Depends(get_project_service),
) -> Dict[str, Any]:
    """Which lakehouse this project uses, and whether dbt builds into it."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _owned_project(session, project_id, user_id)

    row = await session.execute(
        text(
            "SELECT p.lakehouse_connection_id, p.dremio_source_id, "
            "       c.name AS lakehouse_name, "
            "       c.extra_config, w.connection_type AS warehouse_type "
            "FROM dbt_projects p "
            "LEFT JOIN connections c ON c.id = p.lakehouse_connection_id "
            "LEFT JOIN connections w ON w.id = p.connection_id "
            "WHERE p.id = CAST(:pid AS uuid)"
        ),
        {"pid": project_id},
    )
    record = row.mappings().first()
    extra = dict((record or {}).get("extra_config") or {})

    try:
        project_path = project_service.get_path_or_raise(project_id)
        builds = lakes.builds_into_lake(project_path)
    except Exception:
        builds = False

    return {
        "connectionId": str(record["lakehouse_connection_id"])
        if record and record["lakehouse_connection_id"]
        else None,
        "name": (record or {}).get("lakehouse_name"),
        "mode": extra.get("mode"),
        "maintained": extra.get("maintained"),
        "buildIntoLake": builds,
        # Only dbt-duckdb can attach a DuckLake catalog, so the UI can say why
        # rather than offering a choice that produces failed runs. A project with
        # no connection counts: its placeholder profile is DuckDB, and that
        # profile gets the attach block too.
        "warehouseSupportsLake": _warehouse_supports_lake(record),
    }


@router.put("/lakehouse/project/{project_id}")
async def set_project_lakehouse(
    project_id: str,
    request: ProjectLakehouseRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    project_service: ProjectService = Depends(get_project_service),
) -> Dict[str, Any]:
    """Attach or detach a lakehouse, and pin models at it or not.

    Both in one call because they are one decision as far as anyone using this
    is concerned: attaching a lake without `+database: lake` is the state where
    ingest succeeds, the Parquet is there, and dbt quietly writes its marts to
    the local warehouse file instead.
    """
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _owned_project(session, project_id, user_id)

    if request.connection_id is not None:
        lake = await lakes.resolve_lake(session, request.connection_id, owner=user_id)
        if lake is None:
            raise HTTPException(
                status_code=404, detail="Lakehouse not found or not yours"
            )
        await session.execute(
            text(
                "UPDATE dbt_projects SET lakehouse_connection_id = CAST(:cid AS uuid) "
                "WHERE id = CAST(:pid AS uuid)"
            ),
            {"cid": request.connection_id, "pid": project_id},
        )
    elif "connectionId" in request.model_fields_set or "connection_id" in request.model_fields_set:
        await session.execute(
            text(
                "UPDATE dbt_projects SET lakehouse_connection_id = NULL "
                "WHERE id = CAST(:pid AS uuid)"
            ),
            {"pid": project_id},
        )
    await session.commit()

    changed = False
    if request.build_into_lake is not None:
        project_path = project_service.get_path_or_raise(project_id)
        try:
            changed = await asyncio.to_thread(
                lakes.set_builds_into_lake, project_path, request.build_into_lake
            )
        except lakehouse.LakehouseError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"success": True, "projectFileChanged": changed}
