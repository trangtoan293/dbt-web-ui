"""
dbt operations router.
"""

import asyncio
import json
import logging
import shlex
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml as _yaml
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import FileResponse, HTMLResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from adapters import get_adapter
from app.core.auth import require_user, resolve_user_id
from app.core.db import async_session, get_session
from app.core.dependencies import get_dbt_service
from app.core.file_lock import AsyncFileLock
from app.models.dbt import (
    CompileRequest,
    DbtCommand,
    DbtInitRequest,
    DbtIntellisenseColumn,
    DbtIntellisenseDoc,
    DbtIntellisenseMacro,
    DbtIntellisenseModel,
    DbtIntellisenseResponse,
    DbtIntellisenseSource,
    ExplainRequest,
    LineageRequest,
    PreviewRequest,
    QueryRequest,
)
from app.models.docs import DocsGenerateRequest, DocsServeRequest
from app.services.dbt_service import (
    DbtService,
    DBT_PROFILE_SECRET_PLACEHOLDER,
    build_adapter_config_from_connection_row,
    build_adapter_config_from_dremio_source_row,
)
from app.services.command import CommandService
from app.services.project import ProjectService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dbt", tags=["dbt"])


def _redact_profiles_yml(content: str) -> str:
    """Return profiles.yml with credential values masked for diagnostics."""
    try:
        parsed = _yaml.safe_load(content) or {}
    except Exception:
        return "\n".join(
            "***REDACTED***" if any(k in line.lower() for k in ("password:", "pat:", "token:")) else line
            for line in content.splitlines()
        )

    def redact(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: "***REDACTED***"
                if str(key).lower() in {"password", "pat", "token"}
                else redact(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [redact(item) for item in value]
        return value

    return _yaml.safe_dump(redact(parsed), sort_keys=False)


def _manifest_path(node: Dict[str, Any]) -> str:
    return (
        node.get("original_file_path")
        or node.get("patch_path")
        or node.get("path")
        or ""
    )


def _catalog_columns(catalog_node: Optional[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    if not catalog_node:
        return {}
    columns = catalog_node.get("columns") or {}
    if isinstance(columns, dict):
        return columns
    return {}


def _normalize_columns(
    manifest_columns: Any,
    catalog_columns: Optional[Dict[str, Dict[str, Any]]] = None,
) -> List[DbtIntellisenseColumn]:
    catalog_columns = catalog_columns or {}
    if not isinstance(manifest_columns, dict):
        manifest_columns = {}

    names = set(manifest_columns.keys()) | set(catalog_columns.keys())
    normalized: List[DbtIntellisenseColumn] = []
    for name in sorted(names):
        manifest_col = manifest_columns.get(name) or {}
        catalog_col = catalog_columns.get(name) or {}
        if not isinstance(manifest_col, dict):
            manifest_col = {}
        if not isinstance(catalog_col, dict):
            catalog_col = {}
        normalized.append(
            DbtIntellisenseColumn(
                name=name,
                data_type=manifest_col.get("data_type")
                or manifest_col.get("dtype")
                or catalog_col.get("type"),
                description=manifest_col.get("description") or catalog_col.get("comment"),
            )
        )
    return normalized


def _normalize_intellisense(
    manifest: Dict[str, Any],
    catalog: Optional[Dict[str, Any]],
) -> DbtIntellisenseResponse:
    catalog_nodes = (catalog or {}).get("nodes") or {}
    catalog_sources = (catalog or {}).get("sources") or {}
    models: List[DbtIntellisenseModel] = []
    sources: List[DbtIntellisenseSource] = []
    macros: List[DbtIntellisenseMacro] = []
    docs: List[DbtIntellisenseDoc] = []

    for unique_id, node in (manifest.get("nodes") or {}).items():
        if not isinstance(node, dict):
            continue
        resource_type = node.get("resource_type")
        if resource_type == "model":
            models.append(
                DbtIntellisenseModel(
                    name=node.get("name") or unique_id.split(".")[-1],
                    unique_id=unique_id,
                    path=_manifest_path(node),
                    description=node.get("description") or None,
                    columns=_normalize_columns(
                        node.get("columns"),
                        _catalog_columns(catalog_nodes.get(unique_id)),
                    ),
                )
            )

    for unique_id, source in (manifest.get("sources") or {}).items():
        if not isinstance(source, dict):
            continue
        sources.append(
            DbtIntellisenseSource(
                source_name=source.get("source_name") or "",
                table_name=source.get("name") or unique_id.split(".")[-1],
                unique_id=unique_id,
                path=_manifest_path(source),
                description=source.get("description") or None,
                columns=_normalize_columns(
                    source.get("columns"),
                    _catalog_columns(catalog_sources.get(unique_id)),
                ),
            )
        )

    for unique_id, macro in (manifest.get("macros") or {}).items():
        if not isinstance(macro, dict):
            continue
        arguments = macro.get("arguments") or []
        macros.append(
            DbtIntellisenseMacro(
                name=macro.get("name") or unique_id.split(".")[-1],
                package_name=macro.get("package_name"),
                unique_id=unique_id,
                path=_manifest_path(macro),
                description=macro.get("description") or None,
                arguments=arguments if isinstance(arguments, list) else [],
            )
        )

    for unique_id, doc in (manifest.get("docs") or {}).items():
        if not isinstance(doc, dict):
            continue
        docs.append(
            DbtIntellisenseDoc(
                name=doc.get("name") or unique_id.split(".")[-1],
                unique_id=unique_id,
                path=_manifest_path(doc),
            )
        )

    return DbtIntellisenseResponse(
        success=True,
        status="ready",
        generated_at=manifest.get("metadata", {}).get("generated_at"),
        catalog_available=bool(catalog),
        models=sorted(models, key=lambda item: item.name),
        sources=sorted(sources, key=lambda item: (item.source_name, item.table_name)),
        macros=sorted(macros, key=lambda item: (item.package_name or "", item.name)),
        docs=sorted(docs, key=lambda item: item.name),
    )


async def _verify_project_ownership(
    session: AsyncSession, project_id: str, user_id: str
) -> None:
    """Raise 404 if project doesn't exist or isn't owned by user_id (Prisma UUID)."""
    result = await session.execute(
        text(
            "SELECT id FROM dbt_projects "
            "WHERE id = CAST(:pid AS uuid) AND created_by = CAST(:uid AS uuid) "
            "AND deleted_at IS NULL"
        ),
        {"pid": project_id, "uid": user_id},
    )
    if not result.first():
        raise HTTPException(status_code=404, detail="Project not found")


def _dbt_command_name(command: str) -> str:
    parts = shlex.split(command)
    return parts[0] if parts else "run"


def _serialize_dt(value: Any) -> str | None:
    return value.isoformat() if value else None


def _serialize_dbt_run(row: Any, *, include_logs: bool = True) -> dict[str, Any]:
    data = dict(row)
    run = {
        "id": str(data["id"]),
        "project_id": str(data["project_id"]),
        "command": data["command"],
        "selector": data["selector"],
        "status": data["status"],
        "started_at": _serialize_dt(data["started_at"]),
        "completed_at": _serialize_dt(data["completed_at"]),
        "duration_ms": data["duration_ms"],
        "models_total": data["models_total"] or 0,
        "models_success": data["models_success"] or 0,
        "models_error": data["models_error"] or 0,
        "error_message": data["error_message"],
        "results": data["results"],
        "git_commit": data["git_commit"],
        "created_at": _serialize_dt(data["created_at"]),
    }
    if include_logs:
        run["logs"] = data["logs"]
    return run


async def _load_owned_dbt_run(
    session: AsyncSession, run_id: str, user_id: str
) -> dict[str, Any]:
    result = await session.execute(
        text(
            """
            SELECT r.*
            FROM dbt_runs r
            JOIN dbt_projects p ON p.id = r.project_id
            WHERE r.id = CAST(:rid AS uuid)
              AND p.created_by = CAST(:uid AS uuid)
              AND p.deleted_at IS NULL
            """
        ),
        {"rid": run_id, "uid": user_id},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    return dict(row)


async def _run_dbt_in_background(
    request: DbtCommand, user_id: str, run_id: str, started_at: datetime
) -> None:
    try:
        async with async_session() as session:
            await DbtService().run_command(
                request,
                session=session,
                user_id=user_id,
                run_id=run_id,
                started_at=started_at,
                persist_start=False,
            )
    except Exception as exc:
        logger.exception("Background dbt run failed: %s", exc)
        async with async_session() as session:
            await DbtService._update_run_complete(
                session,
                run_id,
                status="error",
                started_at=started_at,
                logs="",
                error_message=str(exc),
            )


@router.post("/command")
async def run_dbt_command(
    request: DbtCommand,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: DbtService = Depends(get_dbt_service),
):
    """Execute a dbt command."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    return await service.run_command(request, session=session, user_id=user_id)


@router.post("/runs", status_code=status.HTTP_202_ACCEPTED)
async def start_dbt_run(
    request: DbtCommand,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    """Start a dbt run asynchronously for external orchestrators."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)

    project_path = await ProjectService().get_or_sync(request.project_id)
    run_id = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc)
    await DbtService._insert_run_start(
        session,
        run_id,
        request.project_id,
        _dbt_command_name(request.command),
        request.selector,
        started_at,
        project_path,
    )
    asyncio.create_task(_run_dbt_in_background(request, user_id, run_id, started_at))
    return {
        "id": run_id,
        "run_id": run_id,
        "project_id": request.project_id,
        "status": "running",
        "started_at": started_at.isoformat(),
    }


@router.get("/runs")
async def list_dbt_runs(
    project_id: str | None = Query(None),
    projectId: str | None = Query(None),
    run_status: str | None = Query(None, alias="status"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    include_logs: bool = Query(False),
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    """List dbt run history visible to the authenticated user."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    pid = project_id or projectId
    params: dict[str, Any] = {"uid": user_id, "limit": limit, "offset": offset}
    filters = [
        "p.created_by = CAST(:uid AS uuid)",
        "p.deleted_at IS NULL",
    ]
    if pid:
        filters.append("r.project_id = CAST(:pid AS uuid)")
        params["pid"] = pid
    if run_status:
        filters.append("r.status = :status")
        params["status"] = run_status

    result = await session.execute(
        text(
            f"""
            SELECT r.*
            FROM dbt_runs r
            JOIN dbt_projects p ON p.id = r.project_id
            WHERE {" AND ".join(filters)}
            ORDER BY r.created_at DESC
            LIMIT :limit OFFSET :offset
            """
        ),
        params,
    )
    return [
        _serialize_dbt_run(row, include_logs=include_logs)
        for row in result.mappings().all()
    ]


@router.get("/runs/{run_id}")
async def get_dbt_run(
    run_id: str,
    include_logs: bool = Query(True),
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    """Get status, summary, logs, and dbt results for one run."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    row = await _load_owned_dbt_run(session, run_id, user_id)
    return _serialize_dbt_run(row, include_logs=include_logs)


@router.get("/runs/{run_id}/logs")
async def get_dbt_run_logs(
    run_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(65536, ge=1, le=1048576),
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    """Read persisted logs for a run without opening an SSE stream."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    row = await _load_owned_dbt_run(session, run_id, user_id)
    logs = row.get("logs") or ""
    chunk = logs[offset : offset + limit]
    next_offset = offset + len(chunk)
    return {
        "run_id": run_id,
        "offset": offset,
        "next_offset": next_offset,
        "has_more": next_offset < len(logs),
        "logs": chunk,
    }


@router.get("/runs/{run_id}/artifacts")
async def get_dbt_run_artifacts(
    run_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    """List per-model artifacts captured from dbt run_results.json."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _load_owned_dbt_run(session, run_id, user_id)
    result = await session.execute(
        text(
            """
            SELECT id, run_id, model_id, unique_id, status, execution_time,
                   compiled_code, error, timing, created_at
            FROM dbt_run_artifacts
            WHERE run_id = CAST(:rid AS uuid)
            ORDER BY created_at ASC
            """
        ),
        {"rid": run_id},
    )
    return [
        {
            "id": str(row["id"]),
            "run_id": str(row["run_id"]),
            "model_id": str(row["model_id"]) if row["model_id"] else None,
            "unique_id": row["unique_id"],
            "status": row["status"],
            "execution_time": row["execution_time"],
            "compiled_code": row["compiled_code"],
            "error": row["error"],
            "timing": row["timing"],
            "created_at": _serialize_dt(row["created_at"]),
        }
        for row in result.mappings().all()
    ]


@router.post("/runs/{run_id}/cancel")
async def cancel_dbt_run(
    run_id: str,
    response: Response,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    """Cancel one running dbt run by run id."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    row = await _load_owned_dbt_run(session, run_id, user_id)
    if row["status"] not in {"pending", "running"}:
        response.status_code = status.HTTP_409_CONFLICT
        return {
            "success": False,
            "run_id": run_id,
            "status": row["status"],
            "message": "Run is already terminal",
        }

    project_id = str(row["project_id"])
    await CommandService.cancel(project_id)
    await AsyncFileLock.force_release(project_id, "dbt_run")
    return {
        "success": True,
        "run_id": run_id,
        "project_id": project_id,
        "message": "Cancellation requested",
    }


@router.post("/regenerate-profiles/{project_id}")
async def regenerate_profiles(
    project_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: DbtService = Depends(get_dbt_service),
):
    """Regenerate profiles.yml from the project's currently stored connection.

    Called after the user switches the connection in the UI so profiles.yml on
    disk reflects the new connection immediately, instead of waiting for the
    next dbt run. Returns regenerated=False when the project has no connection
    (manual profiles.yml is left untouched).
    """
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    project_path = service.project.get_path_or_raise(project_id)
    profile_env = await service._regenerate_profiles_from_db(
        session, project_id, project_path
    )
    has_connection = await session.execute(
        text(
            "SELECT 1 FROM dbt_projects "
            "WHERE id = CAST(:pid AS uuid) "
            "AND deleted_at IS NULL "
            "AND (connection_id IS NOT NULL OR dremio_source_id IS NOT NULL)"
        ),
        {"pid": project_id},
    )
    return {"success": True, "regenerated": bool(has_connection.scalar())}


@router.post("/compile")
async def compile_model(
    request: CompileRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: DbtService = Depends(get_dbt_service),
):
    """Compile a specific dbt model and return SQL."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    return await service.compile_model(request, session=session, user_id=user_id)


@router.post("/preview")
async def preview_model(
    request: PreviewRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: DbtService = Depends(get_dbt_service),
):
    """Preview model data using dbt show command."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    return await service.preview_model(request, session=session, user_id=user_id)


@router.post("/explain")
async def explain_model(
    request: ExplainRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: DbtService = Depends(get_dbt_service),
):
    """Compile a model and return an estimated query plan."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    return await service.explain_model(request, session=session, user_id=user_id)


@router.post("/lineage")
async def get_lineage(
    request: LineageRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: DbtService = Depends(get_dbt_service),
):
    """Get table and column lineage for a dbt model."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    return await service.get_lineage(request)


@router.post("/query")
async def query_warehouse(
    request: QueryRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: DbtService = Depends(get_dbt_service),
):
    """Run a read-only inline SELECT against the project's warehouse."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    return await service.query_warehouse(request, session=session, user_id=user_id)


@router.post("/init")
async def dbt_init(
    request: DbtInitRequest, service: DbtService = Depends(get_dbt_service)
):
    """Initialize a new dbt project from scratch."""
    result = await service.init_project(request)
    if not result["success"]:
        raise HTTPException(
            status_code=500, detail=result.get("message", "Failed to initialize")
        )
    return result


@router.get("/intellisense/{project_id}", response_model=DbtIntellisenseResponse)
async def get_intellisense_metadata(
    project_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: DbtService = Depends(get_dbt_service),
):
    """Return normalized manifest/catalog metadata for editor intellisense."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)

    project_path = service.project.get_path_or_raise(project_id)
    target_path = project_path / "target"
    manifest_path = target_path / "manifest.json"
    catalog_path = target_path / "catalog.json"

    if not manifest_path.exists():
        return DbtIntellisenseResponse(success=True, status="missing_manifest")

    try:
        manifest = json.loads(manifest_path.read_text())
    except Exception:
        return DbtIntellisenseResponse(success=False, status="parse_error")

    catalog: Optional[Dict[str, Any]] = None
    if catalog_path.exists():
        try:
            catalog = json.loads(catalog_path.read_text())
        except Exception:
            catalog = None

    return _normalize_intellisense(manifest, catalog)


# ==================== DOCS ENDPOINTS ====================


@router.post("/docs/generate")
async def generate_docs(
    request: DocsGenerateRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: DbtService = Depends(get_dbt_service),
):
    """Generate dbt documentation (catalog.json, manifest.json)."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    return await service.generate_docs(request, session=session)


@router.post("/docs/serve")
async def serve_docs(
    request: DocsServeRequest, service: DbtService = Depends(get_dbt_service)
):
    """Start dbt docs server as a background process."""
    return await service.serve_docs(request)


@router.post("/docs/stop")
async def stop_docs(
    project_id: str = Query(..., description="Project identifier"),
    service: DbtService = Depends(get_dbt_service),
):
    """Stop running docs server for a project."""
    return await service.stop_docs(project_id)


@router.get("/docs/status")
async def get_docs_status(
    project_id: str = Query(..., description="Project identifier"),
    service: DbtService = Depends(get_dbt_service),
):
    """Get docs server status for a project."""
    return service.get_docs_status(project_id)


@router.get("/docs/list")
async def list_docs_servers(service: DbtService = Depends(get_dbt_service)):
    """List all active docs servers."""
    return {
        "servers": service.list_all_docs_servers(),
        "count": len(service.list_all_docs_servers()),
    }


@router.get("/check-connection/{project_id}")
async def check_connection(
    project_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    """Diagnostic endpoint: verify the 3 conditions for profiles.yml regeneration."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)

    result: Dict[str, Any] = {
        "project_id": project_id,
        "condition_1_has_connection": False,
        "condition_2_profile_names_match": False,
        "condition_3_session_passed": True,  # always true via HTTP
        "connection_type": None,
        "connection_id": None,
        "dremio_source_id": None,
        "profile_name_in_dbt_project_yml": None,
        "profile_name_in_profiles_yml": None,
        "profiles_yml_preview": None,
        "profiles_yml_on_disk": None,
        "errors": [],
    }

    # --- Query project row ---
    proj = await session.execute(
        text(
            "SELECT connection_id, dremio_source_id FROM dbt_projects "
            "WHERE id = CAST(:pid AS uuid) AND deleted_at IS NULL"
        ),
        {"pid": project_id},
    )
    proj_row = proj.mappings().first()
    if not proj_row:
        raise HTTPException(status_code=404, detail="Project not found")

    connection_id = proj_row["connection_id"]
    dremio_source_id = proj_row["dremio_source_id"]
    result["connection_id"] = str(connection_id) if connection_id else None
    result["dremio_source_id"] = str(dremio_source_id) if dremio_source_id else None
    result["condition_1_has_connection"] = bool(connection_id or dremio_source_id)

    # --- Read dbt_project.yml ---
    project_service = ProjectService()
    try:
        project_path = project_service.get_path_or_raise(project_id)
    except Exception as e:
        result["errors"].append(f"Project path not found: {e}")
        return result

    dbt_project_file = project_path / "dbt_project.yml"
    profile_name: Optional[str] = None
    if dbt_project_file.exists():
        try:
            with open(dbt_project_file) as f:
                dbt_proj = _yaml.safe_load(f)
            profile_name = dbt_proj.get("profile") or dbt_proj.get("name")
            result["profile_name_in_dbt_project_yml"] = profile_name
        except Exception as e:
            result["errors"].append(f"Cannot read dbt_project.yml: {e}")
    else:
        result["errors"].append("dbt_project.yml not found — project not yet cloned/init'd")

    # --- Read existing profiles.yml on disk ---
    profiles_file = project_path / "profiles.yml"
    if profiles_file.exists():
        try:
            disk_content = profiles_file.read_text()
            result["profiles_yml_on_disk"] = _redact_profiles_yml(disk_content)[:2000]
            first_key = next(iter(_yaml.safe_load(disk_content) or {}), None)
            result["profile_name_in_profiles_yml"] = first_key
        except Exception as e:
            result["errors"].append(f"Cannot read profiles.yml on disk: {e}")
    else:
        result["errors"].append("profiles.yml not on disk yet")

    # --- Generate preview from DB connection ---
    if result["condition_1_has_connection"] and profile_name:
        try:
            if connection_id:
                conn_res = await session.execute(
                    text(
                        "SELECT connection_type, host, port, database, username, "
                        "password_encrypted, extra_config "
                        "FROM connections WHERE id = CAST(:cid AS uuid)"
                    ),
                    {"cid": str(connection_id)},
                )
                conn_row = conn_res.mappings().first()
                if not conn_row:
                    result["errors"].append("connection_id set but row not found in connections table")
                else:
                    conn_type, adapter_config, _ = (
                        build_adapter_config_from_connection_row(dict(conn_row))
                    )
                    result["connection_type"] = conn_type

                    adapter = get_adapter(conn_type, adapter_config)
                    result["profiles_yml_preview"] = _redact_profiles_yml(
                        adapter.generate_profiles_yml(profile_name)
                    )

            else:  # dremio_source_id
                src_res = await session.execute(
                    text(
                        "SELECT host, port, username, token_encrypted, catalog "
                        "FROM dremio_sources WHERE id = CAST(:sid AS uuid)"
                    ),
                    {"sid": str(dremio_source_id)},
                )
                src_row = src_res.mappings().first()
                if not src_row:
                    result["errors"].append("dremio_source_id set but row not found in dremio_sources table")
                else:
                    conn_type, adapter_config, _ = (
                        build_adapter_config_from_dremio_source_row(dict(src_row))
                    )
                    result["connection_type"] = conn_type
                    adapter = get_adapter(conn_type, adapter_config)
                    result["profiles_yml_preview"] = _redact_profiles_yml(
                        adapter.generate_profiles_yml(profile_name)
                    )

        except Exception as e:
            result["errors"].append(f"Failed to generate profiles preview: {e}")

    # --- Condition 2: profile name match ---
    if result["profile_name_in_dbt_project_yml"] and result["profiles_yml_preview"]:
        preview_key = next(iter(_yaml.safe_load(result["profiles_yml_preview"]) or {}), None)
        result["condition_2_profile_names_match"] = (
            preview_key == result["profile_name_in_dbt_project_yml"]
        )
    elif result["profile_name_in_dbt_project_yml"] and result["profile_name_in_profiles_yml"]:
        result["condition_2_profile_names_match"] = (
            result["profile_name_in_profiles_yml"] == result["profile_name_in_dbt_project_yml"]
        )

    result["all_conditions_met"] = (
        result["condition_1_has_connection"]
        and result["condition_2_profile_names_match"]
        and result["condition_3_session_passed"]
    )

    return result


# ==================== STATIC DOCS SERVING ====================


@router.get("/docs/view/{project_id}", response_class=HTMLResponse)
async def view_docs(project_id: str):
    """
    Serve dbt docs index.html for a project.
    Access via: /dbt/docs/view/{project_id}
    """
    project_service = ProjectService()
    project_path = project_service.get_path_or_raise(project_id)

    index_path = project_path / "target" / "index.html"

    if not index_path.exists():
        raise HTTPException(
            status_code=404, detail="Docs not found. Run 'dbt docs generate' first."
        )

    # Read HTML and rewrite paths to use our static endpoint
    html_content = index_path.read_text()

    # The dbt docs loads manifest.json and catalog.json via relative paths
    # We need to rewrite these to use our static endpoint
    static_base = f"/dbt/docs/static/{project_id}/"

    # Replace relative paths with absolute paths to our static endpoint
    html_content = html_content.replace("manifest.json", f"{static_base}manifest.json")
    html_content = html_content.replace("catalog.json", f"{static_base}catalog.json")

    return HTMLResponse(content=html_content)


@router.get("/docs/static/{project_id}/{file_path:path}")
async def serve_docs_static(project_id: str, file_path: str):
    """
    Serve static files (catalog.json, manifest.json, etc.) for dbt docs.
    """
    project_service = ProjectService()
    project_path = project_service.get_path_or_raise(project_id)

    # Files are in target/ directory
    full_path = project_path / "target" / file_path

    if not full_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

    # Determine content type
    content_type = "application/json"
    if file_path.endswith(".html"):
        content_type = "text/html"
    elif file_path.endswith(".js"):
        content_type = "application/javascript"
    elif file_path.endswith(".css"):
        content_type = "text/css"

    return FileResponse(full_path, media_type=content_type)
