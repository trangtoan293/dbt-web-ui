"""Start a dbt run in the background and report how it ended.

One launch path for every caller: the async `/dbt/runs` endpoint and the
scheduler both come through here, so the run row, the background task and the
completion callback cannot drift apart. Anything that needs "run this project
and tell me the outcome" belongs here rather than in a router.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, Optional

from sqlalchemy import text

from app.core.db import async_session
from app.models.dbt import DbtCommand
from app.services.dbt_service import DbtService
from app.services.project import ProjectService

logger = logging.getLogger(__name__)

# Called with the finished run summary (see _load_run_summary). Awaited inside
# the background task, so a slow notifier delays nothing but itself.
CompletionHook = Callable[[Dict[str, Any]], Awaitable[None]]


def dbt_command_name(command: str) -> str:
    """The bare dbt subcommand from a possibly full command string."""
    import shlex

    parts = shlex.split(command or "")
    return parts[0] if parts else "run"


async def _load_run_summary(run_id: str) -> Dict[str, Any]:
    """Read back how a run ended. Logs are deliberately not selected."""
    async with async_session() as session:
        result = await session.execute(
            text(
                """
                SELECT r.id, r.project_id, r.command, r.selector, r.status,
                       r.started_at, r.completed_at, r.duration_ms,
                       r.models_total, r.models_success, r.models_error,
                       r.error_message, p.name AS project_name
                FROM dbt_runs r
                JOIN dbt_projects p ON p.id = r.project_id
                WHERE r.id = CAST(:rid AS uuid)
                """
            ),
            {"rid": run_id},
        )
        row = result.mappings().first()
    if not row:
        return {"id": run_id, "status": "unknown"}
    summary = dict(row)
    summary["id"] = str(summary["id"])
    summary["project_id"] = str(summary["project_id"])
    return summary


async def _run_in_background(
    request: DbtCommand,
    user_id: str,
    run_id: str,
    started_at: datetime,
    on_complete: Optional[CompletionHook],
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

    if on_complete is None:
        return
    # A failing hook must not turn a finished run into an unhandled task error.
    try:
        await on_complete(await _load_run_summary(run_id))
    except Exception as exc:
        logger.warning("Run completion hook failed for %s: %s", run_id, exc)


async def _ingest_in_background(
    config: Dict[str, Any],
    source_id: str,
    project_id: str,
    dataset: str,
    tables: list,
    source: Dict[str, Any],
    on_complete: Optional[CompletionHook],
) -> None:
    from app.routers.ingest import run_ingest

    run_id: Optional[str] = None
    status, error = "error", None
    rows = 0
    started = datetime.now(timezone.utc)
    try:
        async for event in run_ingest(
            config, source_id, project_id, dataset=dataset, tables=tables, source=source
        ):
            kind = event.get("type")
            if kind == "started":
                run_id = event.get("run_id")
            elif kind == "completed":
                status = "success"
                rows = sum(int(v) for v in (event.get("row_counts") or {}).values())
            elif kind == "error":
                error = str(event.get("message") or "")
    except Exception as exc:
        logger.exception("Scheduled ingest failed for source %s: %s", source_id, exc)
        error = str(exc)

    if on_complete is None:
        return
    completed = datetime.now(timezone.utc)
    try:
        # Shaped like a dbt run summary so the webhook payload and the schedule's
        # last_status need no second code path. `command` names what actually
        # ran, which is what a Slack message has to say.
        await on_complete(
            {
                "id": run_id,
                "project_id": project_id,
                "project_name": str(source.get("name") or "ingest"),
                "command": "ingest",
                "selector": ", ".join(str(t) for t in tables[:5]),
                "status": status,
                "duration_ms": int((completed - started).total_seconds() * 1000),
                "models_total": len(tables),
                "models_error": 0 if status == "success" else len(tables),
                "rows_loaded": rows,
                "error_message": error,
            }
        )
    except Exception as exc:
        logger.warning("Ingest completion hook failed for %s: %s", source_id, exc)


async def launch_ingest_run(
    source_id: str,
    user_id: str,
    *,
    session,
    full_refresh: bool = False,
    on_complete: Optional[CompletionHook] = None,
) -> Dict[str, Any]:
    """Start one ingest load in the background and return its identifiers.

    The scheduler's counterpart to `launch_dbt_run`, so both kinds of scheduled
    work are started the same way and recorded the same way.

    ponytail: the ingest machinery - loading a source, building a job config,
    streaming the subprocess - lives in `app/routers/ingest.py` because that is
    where it grew, so it is imported inside the function rather than at module
    level: a service importing a router at import time is how a cycle starts.
    Moving it into a service of its own is the right seam; it is not worth 400
    lines of cut-and-paste to put a load on a cron.
    """
    from app.routers.ingest import (
        _load_source,
        drop_incremental_state,
        prepare_job,
    )

    source = await _load_source(session, source_id, user_id)
    config, dataset, tables = await prepare_job(session, source)
    if full_refresh:
        drop_incremental_state(config)

    project_id = str(source["project_id"])
    asyncio.create_task(
        _ingest_in_background(
            config,
            source_id,
            project_id,
            dataset,
            tables,
            source,
            on_complete,
        )
    )
    return {
        "id": source_id,
        "run_id": None,
        "project_id": project_id,
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
    }


async def launch_dbt_run(
    request: DbtCommand,
    user_id: str,
    *,
    session,
    on_complete: Optional[CompletionHook] = None,
) -> Dict[str, Any]:
    """Insert the run row, start the run, and return its identifiers.

    Returns as soon as the row exists - the dbt process outlives this call.
    """
    project_path = await ProjectService().get_or_sync(request.project_id)
    run_id = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc)
    await DbtService._insert_run_start(
        session,
        run_id,
        request.project_id,
        dbt_command_name(request.command),
        request.selector,
        started_at,
        project_path,
    )
    asyncio.create_task(
        _run_in_background(request, user_id, run_id, started_at, on_complete)
    )
    return {
        "id": run_id,
        "run_id": run_id,
        "project_id": request.project_id,
        "status": "running",
        "started_at": started_at.isoformat(),
    }
