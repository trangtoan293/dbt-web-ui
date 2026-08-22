"""Deployment facts the UI needs but that only exist as environment variables.

Everything here is read-only and hand-picked. `Settings` also holds
`app_encryption_key`, `database_url`, `lake_catalog_url` and the OIDC config, so
this must never serialise the settings object - a dump would hand the browser
the key that decrypts every stored warehouse password.
"""

from typing import Any, Dict

from fastapi import APIRouter, Depends

from adapters import list_adapters
from app.config import settings
from app.core.auth import require_user
from app.services.scheduler import run_scheduler
from ingest import lakehouse

router = APIRouter(tags=["System"])

VERSION = "0.1.0"


@router.get("/system/info")
async def system_info(claims: dict = Depends(require_user)) -> Dict[str, Any]:
    """Operational settings that otherwise require shell access to read.

    Requires a session: it describes the deployment, not the public service.
    """
    return {
        "version": VERSION,
        "auth": {
            "mode": "disabled" if settings.auth_disabled else "oidc",
            "issuer_configured": bool(settings.oidc_issuer),
        },
        "runs": {
            "max_concurrent": settings.max_concurrent_dbt_runs,
            "per_project_concurrent": settings.max_concurrent_commands_per_project,
            "subprocess_timeout_seconds": settings.dbt_subprocess_timeout,
            "history_retention_days": settings.run_history_retention_days,
        },
        "scheduler": {
            "enabled": settings.scheduler_enabled,
            "running": run_scheduler.is_running,
            # Leaderless means no Redis: safe with one worker, double-fires with two.
            "leader": run_scheduler.is_leader,
            "tick_seconds": settings.scheduler_tick_seconds,
            "misfire_grace_seconds": settings.scheduler_misfire_grace_seconds,
        },
        "worker": {
            "warm_pool_enabled": settings.dbt_warm_worker_enabled,
            "warm_pool_size": settings.dbt_warm_worker_count,
        },
        "lakehouse": {
            "configured": lakehouse.is_configured(),
            "snapshot_retention_days": settings.lake_snapshot_retention_days,
            "maintenance_interval_hours": settings.maintenance_interval_hours,
            "inline_row_limit": settings.lake_inline_row_limit,
        },
        "ingest": {
            "allow_private_hosts": settings.ingest_allow_private_hosts,
            "subprocess_timeout_seconds": settings.ingest_subprocess_timeout,
        },
        "adapters": sorted(list_adapters().keys()),
    }
