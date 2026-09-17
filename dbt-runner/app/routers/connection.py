"""
Connection and profiles router.
"""

import asyncio
import logging
from typing import Any, Dict

import yaml
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from adapters import get_adapter, list_adapters
from app.core.db import get_session
from app.core.host_guard import HostNotAllowed, assert_host_allowed
from app.core.dependencies import get_project_service
from app.models.connection import (
    ConnectionSchemaRequest,
    ConnectionTestRequest,
    DremioTestRequest,
)
from app.services.project import ProjectService
from ingest.rest_source import UnsupportedRestSource, probe_rest
from ingest.sql_source import (
    SOURCE_ONLY_TYPES,
    UnsupportedSource,
    build_url_from_config,
    probe,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Connections"])

# DuckDB is a local file and Spark is reached through its own session config, so
# neither carries a network host to check.
_HOSTLESS_TYPES = {"duckdb", "spark"}

# Connection types with no dbt adapter, tested through the same code path ingest
# reads them with. `rest` is not in SOURCE_ONLY_TYPES because it is not SQL.
_REST_TYPE = "rest"


def _assert_target_allowed(conn_type: str, config: Dict[str, Any]) -> None:
    """Refuse connections aimed at this deployment's own infrastructure.

    Without this, a user can point a connection at the application's Postgres,
    attach it to a project, and read every other user's encrypted warehouse
    credentials out of the `connections` table through ordinary dbt queries.
    """
    if conn_type in _HOSTLESS_TYPES:
        return
    host = str((config or {}).get("host") or "").strip()
    if not host:
        return
    raw_port = (config or {}).get("port")
    try:
        port = int(raw_port) if raw_port else None
    except (TypeError, ValueError):
        port = None
    assert_host_allowed(host, port)


@router.get("/connection/usage/{connection_id}")
async def get_connection_usage(
    connection_id: str,
    session: AsyncSession = Depends(get_session),
):
    """
    Check which projects are using this connection.
    Returns list of projects that have this connection assigned.
    """
    try:
        logger.info(
            f"[CONNECTION USAGE CHECK] Checking usage for connection_id: {connection_id}"
        )

        # Both columns matter: a warehouse connection is attached through
        # connection_id, a legacy Dremio source through dremio_source_id.
        # Checking only the latter reported every warehouse connection as unused.
        result = await session.execute(
            text(
                "SELECT id, name, description, connection_id, dremio_source_id "
                "FROM dbt_projects "
                "WHERE (connection_id = CAST(:cid AS uuid) "
                "       OR dremio_source_id = CAST(:cid AS uuid)) "
                "AND deleted_at IS NULL"
            ),
            {"cid": connection_id},
        )
        projects = [dict(row) for row in result.mappings().all()]

        # Ingest sources read through a connection and the foreign key is
        # RESTRICT, so deleting one they use fails at the database. Report them
        # so the UI can say which, rather than surfacing a constraint error.
        sources: list[dict] = []
        exists = await session.execute(
            text("SELECT to_regclass('ingest_sources') IS NOT NULL")
        )
        if exists.scalar():
            source_rows = await session.execute(
                text(
                    "SELECT s.id, s.name, s.dataset, p.name AS project_name "
                    "FROM ingest_sources s "
                    "JOIN dbt_projects p ON p.id = s.project_id "
                    "WHERE s.source_connection_id = CAST(:cid AS uuid)"
                ),
                {"cid": connection_id},
            )
            sources = [dict(row) for row in source_rows.mappings().all()]

        logger.info(
            "[CONNECTION USAGE CHECK] connection %s used by %d project(s), %d ingest source(s)",
            connection_id,
            len(projects),
            len(sources),
        )

        return {
            "in_use": bool(projects or sources),
            "project_count": len(projects),
            "projects": projects,
            "ingest_source_count": len(sources),
            "ingest_sources": sources,
            # Deleting is refused by the database while an ingest source reads it.
            "blocked": bool(sources),
        }
    except Exception as e:
        logger.error(f"Error checking connection usage: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/connection/adapters")
async def list_available_adapters():
    """List all available connection adapter types."""
    return {"adapters": list_adapters(), "supported": list(list_adapters().keys())}


@router.post("/connection/test")
async def test_connection(request: ConnectionTestRequest):
    """
    Test any connection type using the adapter pattern.
    Supports: postgresql, duckdb, dremio (and more as added)
    """
    logger.debug(f"[CONNECTION TEST] type={request.type}, name={request.name}")

    try:
        _assert_target_allowed(request.type, request.config)
    except HostNotAllowed as e:
        return {"success": False, "message": str(e)}

    # Source-only types have no adapter on purpose (see
    # ingest/sql_source.SOURCE_ONLY_TYPES), so they are probed the way ingest
    # will actually read them rather than through a registry entry that would
    # also offer them to dbt.
    if request.type in SOURCE_ONLY_TYPES:
        try:
            url = build_url_from_config(request.type, request.config)
        except (UnsupportedSource, HostNotAllowed) as e:
            return {"success": False, "message": str(e)}
        return await asyncio.to_thread(probe, url)

    if request.type == _REST_TYPE:
        try:
            return await probe_rest(request.config)
        except (UnsupportedRestSource, HostNotAllowed) as e:
            return {"success": False, "message": str(e)}

    try:
        adapter = get_adapter(request.type, request.config)
        result = await adapter.test_connection()
        return result
    except ValueError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        return {"success": False, "message": f"Unexpected error: {str(e)}"}


@router.post("/connection/schema")
async def extract_connection_schema(request: ConnectionSchemaRequest):
    """
    Extract schema (tables, views, columns) from any connection type.
    Returns the complete schema metadata for the database.
    """
    try:
        _assert_target_allowed(request.type, request.config)
    except HostNotAllowed as e:
        return {"success": False, "message": str(e), "schema": None}

    try:
        adapter = get_adapter(request.type, request.config)
        schema = await adapter.extract_schema()
        return {"success": True, "schema": schema}
    except ValueError as e:
        return {"success": False, "message": str(e), "schema": None}
    except Exception as e:
        return {
            "success": False,
            "message": f"Schema extraction failed: {str(e)}",
            "schema": None,
        }


