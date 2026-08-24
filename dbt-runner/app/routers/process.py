"""
Process management router.
"""

import logging

from fastapi import APIRouter

from app.core.file_lock import AsyncFileLock
from app.services.command import CommandService
from app.services.dbt_worker import warm_worker_pool

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/process", tags=["Process"])


@router.post("/cancel")
async def cancel_process(project_id: str):
    """
    Cancel a running process for a project.
    Also releases any file locks held by the cancelled process.
    """
    # Try to cancel multiple possible process IDs
    process_ids = [
        project_id,
        f"{project_id}:preview",  # Preview uses this format
        f"{project_id}:compile",
    ]

    cancelled_any = False
    for pid in process_ids:
        if await CommandService.is_running(pid):
            cancelled = await CommandService.cancel(pid)
            if cancelled:
                logger.info(f"Cancelled process: {pid}")
                cancelled_any = True

    # CommandService only knows the subprocess fallback. dbt normally runs in
    # this project's warm worker, and nothing above can reach that process, so
    # Stop did nothing at all for the common case. Releasing the pool kills the
    # dbt process holding the job; the pool restarts on the next command.
    if await warm_worker_pool.release_project(project_id, cancel=True):
        logger.info("Released warm workers for project %s on cancel", project_id)
        cancelled_any = True

    # Also force release any file locks for this project
    for resource in ["preview", "dbt_run", "compile"]:
        try:
            released = await AsyncFileLock.force_release(project_id, resource)
            if released:
                logger.info(f"Force released lock: {project_id}:{resource}")
        except Exception as e:
            logger.warning(f"Failed to release lock {resource}: {e}")

    if cancelled_any:
        return {"success": True, "message": "Process cancelled and locks released"}
    return {"success": True, "message": "Locks cleared (no running process found)"}


@router.get("/status")
async def process_status(project_id: str):
    """Check if a process is running for a project."""
    # Check multiple possible process IDs
    process_ids = [project_id, f"{project_id}:preview"]

    for pid in process_ids:
        if await CommandService.is_running(pid):
            return {"running": True, "process_id": pid}

    return {"running": False}
