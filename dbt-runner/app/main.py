"""
dbt-runner: FastAPI service for executing dbt commands
Refactored from monolithic structure to modular architecture.
"""

import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.core.db import async_session
from app.core.logging import setup_logging
from app.core.metrics import PrometheusMetricsMiddleware
from app.core.request_logging import RequestLoggingMiddleware
from app.core.redis_client import check_redis_health, close_redis
from app.core.session_middleware import SessionMiddleware
from app.exceptions import DbtRunnerException
from app.services.dbt_service import DbtService
from app.services.dbt_worker import warm_worker_pool
from app.services.scheduler import run_scheduler

# Import all routers
from app.routers import (
    client_logs_router,
    connection_router,
    dbt_router,
    dremio_router,
    files_router,
    git_router,
    health_router,
    ingest_router,
    process_router,
    project_router,
    sse_router,
    system_router,
)

# Setup logging
setup_logging()
logger = logging.getLogger(__name__)


def _runner_instance_id() -> str:
    """Identify the current Uvicorn master process across its worker children."""
    parent_pid = os.getppid()
    try:
        start_ticks = Path(f"/proc/{parent_pid}/stat").read_text().split()[21]
    except (IndexError, OSError):
        start_ticks = "unknown"
    return f"{parent_pid}-{start_ticks}"


async def _reconcile_stale_runs_once(
    marker_dir: Path = Path("/tmp"), instance_id: str | None = None
) -> int | None:
    """Reconcile once per runner launch so worker startups do not cancel live runs."""
    instance_id = instance_id or _runner_instance_id()
    marker = marker_dir / f".dbt-runner-history-reconciled-{instance_id}"
    lock = marker_dir / f".dbt-runner-history-reconcile-{instance_id}.lock"
    if marker.exists():
        return None

    try:
        lock_fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return None

    os.close(lock_fd)
    try:
        async with async_session() as session:
            stale_runs = await DbtService.reconcile_stale_runs(session)
        marker.touch()
        return stale_runs
    finally:
        lock.unlink(missing_ok=True)


def create_app() -> FastAPI:
    """Application factory for creating FastAPI app."""

    app = FastAPI(
        title="dbt-runner",
        description="Service for executing dbt commands and Git operations",
        version="0.1.0",
        docs_url="/docs",
        redoc_url="/redoc",
    )

    # Add session middleware (must be before CORS)
    app.add_middleware(SessionMiddleware)
    app.add_middleware(PrometheusMetricsMiddleware)

    # Configure CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=settings.cors_allow_credentials,
        allow_methods=settings.cors_allow_methods,
        allow_headers=settings.cors_allow_headers,
        expose_headers=["X-Session-ID"],  # Allow frontend to read session ID
    )

    # Outermost middleware: bind a request id + log request timing early.
    app.add_middleware(RequestLoggingMiddleware)

    # Register exception handlers
    @app.exception_handler(DbtRunnerException)
    async def dbt_runner_exception_handler(request: Request, exc: DbtRunnerException):
        """Handle custom exceptions."""
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "success": False,
                "message": exc.message,
                "details": exc.details,
            },
        )

    @app.exception_handler(TimeoutError)
    async def timeout_exception_handler(request: Request, exc: TimeoutError):
        """Handle lock timeout exceptions."""
        logger.warning(f"Lock timeout: {exc}")
        return JSONResponse(
            status_code=503,
            content={
                "success": False,
                "message": str(exc),
                "details": {"error": "lock_timeout"},
            },
        )

    @app.exception_handler(Exception)
    async def general_exception_handler(request: Request, exc: Exception):
        """Handle unexpected exceptions."""
        logger.exception(f"Unexpected error: {exc}")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "message": "Internal server error",
                "details": {"error": str(exc)},
            },
        )

    # Register routers
    app.include_router(health_router)
    app.include_router(client_logs_router)
    app.include_router(process_router)
    app.include_router(dbt_router)
    app.include_router(git_router)
    app.include_router(files_router)
    app.include_router(connection_router)
    app.include_router(ingest_router)
    app.include_router(project_router)
    app.include_router(sse_router)
    app.include_router(dremio_router)
    app.include_router(system_router)

    # Startup event
    @app.on_event("startup")
    async def startup_event():
        logger.info("Starting dbt-runner service v0.1.0...")
        logger.info(f"Workspace directory: {settings.workspace_dir}")
        logger.info(f"Redis URL: {settings.redis_url}")
        logger.info(
            "dbt warm worker enabled=%s workers=%s queue_size=%s",
            settings.dbt_warm_worker_enabled,
            settings.dbt_warm_worker_count,
            settings.dbt_warm_worker_queue_size,
        )

        # === Health check: Verify workspace is accessible ===
        workspace = Path(settings.workspace_dir)
        try:
            workspace.mkdir(parents=True, exist_ok=True)
            test_file = workspace / ".health_check"
            test_file.write_text("ok")
            test_file.unlink()
            logger.info("Workspace directory is writable")
        except Exception as e:
            logger.error(f"Workspace not writable: {e}")
            # Don't raise - allow service to start but log error

        # === Cleanup stale Git lock files from previous crash ===
        try:
            git_locks_cleaned = 0
            for lock_file in workspace.rglob(".git/index.lock"):
                try:
                    lock_file.unlink()
                    git_locks_cleaned += 1
                    logger.warning(f"Removed stale Git lock: {lock_file}")
                except Exception as e:
                    logger.error(f"Failed to remove Git lock {lock_file}: {e}")

            # Also clean other common Git lock files
            for lock_pattern in [".git/*.lock", ".git/refs/heads/*.lock"]:
                for lock_file in workspace.rglob(lock_pattern):
                    try:
                        lock_file.unlink()
                        git_locks_cleaned += 1
                        logger.warning(f"Removed stale Git lock: {lock_file}")
                    except Exception as e:
                        logger.error(f"Failed to remove Git lock {lock_file}: {e}")

            if git_locks_cleaned > 0:
                logger.info(f"Cleaned up {git_locks_cleaned} stale Git lock files")
        except Exception as e:
            logger.warning(f"Failed to cleanup Git locks: {e}")

        # === Reconcile dbt runs abandoned by a previous runner process ===
        try:
            stale_runs = await _reconcile_stale_runs_once()
            if stale_runs:
                logger.warning(
                    f"Marked {stale_runs} stale dbt runs as cancelled after restart"
                )
        except Exception as e:
            logger.warning(f"Failed to reconcile stale dbt runs: {e}")

        # === Verify Redis connection ===
        redis_ok = await check_redis_health()
        if redis_ok:
            logger.info("Redis connection verified")

            # Clean up stale locks from previous crash
            try:
                from app.core.redis_client import get_redis

                redis = await get_redis()
                if redis:
                    # Find and clean stale file locks
                    stale_locks = []
                    async for key in redis.scan_iter("file_lock:*"):
                        stale_locks.append(key)

                    if stale_locks:
                        logger.warning(
                            f"Cleaning up {len(stale_locks)} stale locks from previous session"
                        )
                        for key in stale_locks:
                            await redis.delete(key)
                            logger.debug(f"Deleted stale lock: {key}")

                    # Clean up stale process registrations
                    stale_processes = []
                    async for key in redis.scan_iter("running_process:*"):
                        stale_processes.append(key)

                    if stale_processes:
                        logger.warning(
                            f"Cleaning up {len(stale_processes)} stale process registrations"
                        )
                        for key in stale_processes:
                            await redis.delete(key)
            except Exception as e:
                logger.warning(f"Failed to clean up stale locks: {e}")
        else:
            logger.warning("Redis not available - distributed locking disabled")

        # === Warm dbt worker pool for parse/compile/list commands ===
        try:
            await warm_worker_pool.start()
        except Exception as e:
            logger.warning(f"Failed to start dbt warm worker pool: {e}")

        # === Scheduler: cron runs, history retention, lake maintenance ===
        # Leader-elected through Redis, so starting it in every worker is safe.
        try:
            await run_scheduler.start()
        except Exception as e:
            logger.warning(f"Failed to start scheduler: {e}")

    # Shutdown event
    @app.on_event("shutdown")
    async def shutdown_event():
        logger.info("Shutting down dbt-runner service...")

        # Stop the scheduler before Redis closes - it releases its leader lease.
        await run_scheduler.stop()

        # Stop warm dbt workers before closing shared resources
        await warm_worker_pool.stop()

        # Close Redis connection
        await close_redis()

        logger.info("Cleanup complete, service stopped.")

    return app


# Create application instance
app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
    )
