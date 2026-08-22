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
