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
        result = await asyncio.to_thread(
            iceberg.publish,
            project_id,
            schema=request.schema_name,
            tables=request.tables,
        )
    except (iceberg.IcebergPublishError, lakehouse.LakehouseError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Iceberg publish failed for %s", project_id)
        raise HTTPException(status_code=500, detail=f"Publish failed: {exc}") from exc

    return {"success": True, **result}
