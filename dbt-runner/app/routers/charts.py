"""Authenticated rendering of client-supplied query results, without warehouse access."""

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.auth import resolve_user_id, verify_project_ownership
from app.core.db import get_session
from app.core.dependencies import get_dbt_service
from app.models.dbt import QueryRequest
from app.services.dbt_service import DbtService
from app.services.boards import validate_board, render_board, compose_board, add_chart, preview_query, preview_sql
from app.services.chart_reference import reference

from app.core.auth import require_user
from app.services.charts import MAX_BYTES, ChartRequest, render_chart

router = APIRouter(prefix="/charts", tags=["charts"])


@router.post("/{project_id}/board/{action}")
async def board_action(project_id: str, action: str, raw: Request, response: Response,
                       claims: dict = Depends(require_user), session: AsyncSession = Depends(get_session),
                       service: DbtService = Depends(get_dbt_service)):
    response.headers["Cache-Control"] = "no-store"
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await verify_project_ownership(session, project_id, user_id)
    if action not in {"validate", "render", "compose", "chart", "query", "sql"}:
        raise HTTPException(404, "Unknown board action")
    body = bytearray()
    async for chunk in raw.stream():
        body.extend(chunk)
        if len(body) > MAX_BYTES:
            raise HTTPException(413, "Board exceeds 2 MB")
    import json
    try:
        payload = json.loads(body)
        if not isinstance(payload, dict) or not isinstance(payload.get("yaml"), str) or not isinstance(payload.get("variables", {}), dict):
            raise ValueError("Expected yaml text and variables mapping")
        if action == "validate":
            return await validate_board(payload["yaml"])
        if action == "compose":
            return compose_board(payload["yaml"], payload.get("chart_yaml", ""), payload.get("sql", ""), payload.get("columns", []))
        if action == "chart":
            return add_chart(payload["yaml"], payload.get("chart", {}), payload.get("columns", []))
        async def query(sql):
            return await service.query_warehouse(QueryRequest(project_id=project_id, sql=sql, limit=1000, target=payload.get("target")), session=session, user_id=user_id)
        if action == "query":
            return await preview_query(payload["yaml"], payload.get("variables", {}), payload.get("name", ""), query)
        if action == "sql":
            return await preview_sql(payload.get("sql", ""), query)
        return await render_board(payload["yaml"], payload.get("variables", {}), query)
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, {"message": str(exc), "diagnostics": getattr(exc, "diagnostics", [])}) from exc
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(504, "Dashboard rendering timed out") from exc


@router.get("/reference")
async def chart_reference(response: Response, claims: dict = Depends(require_user)):
    """Board specimens and the YAML reference that ship with the pinned engine."""
    response.headers["Cache-Control"] = "private, max-age=3600"
    return reference()


@router.get("/{project_id}/environment")
async def environment(project_id: str, claims: dict = Depends(require_user), session: AsyncSession = Depends(get_session),
                      service: DbtService = Depends(get_dbt_service)):
    import yaml
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await verify_project_ownership(session, project_id, user_id)
    root = service.project.get_path_or_raise(project_id)
    profile_file = root / "profiles.yml"
    if not profile_file.is_file():
        return {"default": None, "targets": [], "notice": "Connection metadata unavailable until the project profile is configured."}
    profile = yaml.safe_load(profile_file.read_text()) or {}
    project = yaml.safe_load((root / "dbt_project.yml").read_text()) if (root / "dbt_project.yml").exists() else {}
    active = profile.get((project or {}).get("profile"), {})
    def display(value):
        text = str(value or "")
        return "configured" if "{{" in text else text
    return {"default": active.get("target"), "targets": [
        {"name": name, "type": config.get("type"), "database": display(config.get("database") or config.get("dbname")), "schema": display(config.get("schema"))}
        for name, config in active.get("outputs", {}).items() if isinstance(config, dict)
    ]}


@router.post("/render")
async def render(raw: Request, response: Response, claims: dict = Depends(require_user)):
    response.headers["Cache-Control"] = "no-store"
    body = bytearray()
    async for chunk in raw.stream():
        body.extend(chunk)
        if len(body) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="Chart data exceeds the 2 MB limit")
    try:
        request = ChartRequest.model_validate_json(body)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_input=False, include_context=False)) from exc
    try:
        return await render_chart(request)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Chart rendering timed out. Reduce the number of rows.") from exc
