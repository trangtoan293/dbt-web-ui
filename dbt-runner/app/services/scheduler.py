"""Cron for dbt runs, plus the periodic housekeeping nothing else owns.

Three jobs, one loop:

* fire `dbt_schedules` rows whose cron is due, and notify on failure
* prune `dbt_runs` / `ingest_runs` past the retention window - run rows carry
  full log text, so history is the fastest growing table in the deployment
* expire DuckLake snapshots and delete orphaned files, or the storage volume
  only ever grows

Exactly one process does this at a time: uvicorn can be started with several
workers (`DBT_RUNNER_UVICORN_WORKERS`) and a deployment can run several
replicas, so leadership is a Redis key with a TTL that the leader refreshes.
Without Redis the loop still runs - the default deployment is one worker - but
says so, because two leaderless workers would fire every schedule twice.

ponytail: one poll loop over a `next_run_at` column, not an in-memory job
registry. State lives in Postgres, so a restart loses nothing and there is
nothing to rebuild on boot.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from croniter import CroniterBadCronError, croniter
from sqlalchemy import text

from app.config import settings
from app.core.db import async_session
from app.core.file_lock import AsyncFileLock
from app.core.redis_client import get_redis
from app.models.dbt import DbtCommand
from app.services.notify import post_run_notification
from app.services.run_launcher import launch_dbt_run
from ingest import iceberg, lakehouse

logger = logging.getLogger(__name__)

LEADER_KEY = "dbt-runner:scheduler:leader"
MAINTENANCE_KEY = "dbt-runner:scheduler:maintenance-done"

# Terminal statuses. A prune must never delete a row a run is still writing to.
_TERMINAL_STATUSES = ("success", "error", "cancelled")


def next_fire_time(expression: str, after: datetime) -> Optional[datetime]:
    """The first time `expression` fires after `after`, in UTC.

    Returns None for an expression croniter cannot parse - a typo in one
    schedule must not stop every other schedule from running.
    """
    reference = after if after.tzinfo else after.replace(tzinfo=timezone.utc)
    try:
        return croniter(expression, reference).get_next(datetime).astimezone(
            timezone.utc
        )
    except (CroniterBadCronError, KeyError, ValueError) as exc:
        logger.warning("Unusable cron expression %r: %s", expression, exc)
        return None


def is_misfire(due_at: Optional[datetime], now: datetime, grace_seconds: int) -> bool:
    """Whether a due time is too old to still be worth running.

    After an outage the backlog would otherwise all fire at once, which for a
    nightly `dbt build` means several concurrent runs of the same project.
    """
    if due_at is None:
        return False
    due = due_at if due_at.tzinfo else due_at.replace(tzinfo=timezone.utc)
    return (now - due).total_seconds() > grace_seconds


class RunScheduler:
    """Owns the background loop. One instance per process."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._instance = f"{id(self)}"
        self._is_leader = False
        # Fallback for a Redis-less deployment: remember locally instead.
        self._last_maintenance: Optional[datetime] = None

    async def start(self) -> None:
        if not settings.scheduler_enabled:
            logger.info("Scheduler disabled (SCHEDULER_ENABLED=false)")
            return
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop(), name="run-scheduler")
        logger.info(
            "Scheduler started (tick=%ss retention=%sd lake_retention=%sd)",
            settings.scheduler_tick_seconds,
            settings.run_history_retention_days,
            settings.lake_snapshot_retention_days,
        )

    async def stop(self) -> None:
        if not self._task:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        await self._release_leader()
        logger.info("Scheduler stopped")

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def is_leader(self) -> bool:
        """True when this process currently holds (or stands in for) the lease."""
        return self._is_leader

    # --- leadership -----------------------------------------------------

    async def _acquire_leader(self) -> bool:
        """Take or refresh the leader lease. True when this process may work."""
        try:
            redis = await get_redis()
        except Exception as exc:
            if not self._is_leader:
                logger.warning(
                    "Scheduler running without Redis leader election (%s). "
                    "With more than one runner worker this double-fires schedules.",
                    exc,
                )
            self._is_leader = True
            return True

        ttl = settings.scheduler_leader_ttl
        if await redis.set(LEADER_KEY, self._instance, nx=True, ex=ttl):
            self._is_leader = True
            return True
        if await redis.get(LEADER_KEY) == self._instance:
            # Refresh our own lease rather than waiting for it to lapse.
            await redis.expire(LEADER_KEY, ttl)
            self._is_leader = True
            return True
        self._is_leader = False
        return False

    async def _release_leader(self) -> None:
        if not self._is_leader:
            return
        try:
            redis = await get_redis()
            if await redis.get(LEADER_KEY) == self._instance:
                await redis.delete(LEADER_KEY)
        except Exception:
            pass  # the TTL takes care of it
        self._is_leader = False

    # --- loop -----------------------------------------------------------

    async def _loop(self) -> None:
        while True:
            try:
                if await self._acquire_leader():
                    await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # A bad tick must never end the loop - nothing would restart it.
                logger.exception("Scheduler tick failed: %s", exc)
            await asyncio.sleep(settings.scheduler_tick_seconds)

    async def _tick(self) -> None:
        now = datetime.now(timezone.utc)
        await self._fire_due_schedules(now)
        if await self._maintenance_due(now):
            await self._run_maintenance()

    # --- schedules ------------------------------------------------------

    async def _fire_due_schedules(self, now: datetime) -> int:
        async with async_session() as session:
            result = await session.execute(
                text(
                    """
                    SELECT s.id, s.project_id, s.name, s.command, s.selector,
                           s.target, s.cron, s.webhook_url, s.publish_schema,
                           s.next_run_at, s.created_by
                    FROM dbt_schedules s
                    JOIN dbt_projects p ON p.id = s.project_id
                    WHERE s.is_active = true
                      AND p.deleted_at IS NULL
                      AND (s.next_run_at IS NULL OR s.next_run_at <= :now)
                    ORDER BY s.next_run_at NULLS FIRST
                    """
                ),
                {"now": now},
            )
            due: List[Dict[str, Any]] = [dict(row) for row in result.mappings().all()]

        fired = 0
        for schedule in due:
            try:
                if await self._handle_due_schedule(schedule, now):
                    fired += 1
            except Exception as exc:
                logger.exception(
                    "Schedule '%s' could not be started: %s", schedule["name"], exc
                )
        return fired

    async def _handle_due_schedule(
        self, schedule: Dict[str, Any], now: datetime
    ) -> bool:
        """Advance one schedule and start its run. True when a run started."""
        schedule_id = str(schedule["id"])
        upcoming = next_fire_time(schedule["cron"], now)

        # Advance first, launch second. A crash between the two skips one run;
        # the other order re-fires the same run on every tick until it lands.
        async with async_session() as session:
            await session.execute(
                text(
                    "UPDATE dbt_schedules SET next_run_at = :next WHERE id = CAST(:sid AS uuid)"
                ),
                {"next": upcoming, "sid": schedule_id},
            )
            await session.commit()

        if upcoming is None:
            return False  # unparseable cron; already logged, now inert

        first_tick = schedule["next_run_at"] is None
        if first_tick:
            # A schedule created just now has no due time yet. Arm it for its
            # next cron slot instead of firing the moment it is saved.
            logger.info(
                "Schedule '%s' armed, first run at %s", schedule["name"], upcoming
            )
            return False

        if is_misfire(
            schedule["next_run_at"], now, settings.scheduler_misfire_grace_seconds
        ):
            logger.warning(
                "Schedule '%s' was due at %s, past the %ss grace window - skipped",
                schedule["name"],
                schedule["next_run_at"],
                settings.scheduler_misfire_grace_seconds,
            )
            return False

        command = str(schedule["command"] or "run")
        request = DbtCommand(
            project_id=str(schedule["project_id"]),
            # The enum stores source_freshness; the CLI wants two words.
            command="source freshness" if command == "source_freshness" else command,
            selector=schedule["selector"] or None,
            target=schedule["target"] or None,
        )

        async def on_complete(run: Dict[str, Any]) -> None:
            await self._record_outcome(schedule_id, run)
            if run.get("status") != "success" and schedule.get("webhook_url"):
                await post_run_notification(
                    schedule["webhook_url"], run, schedule["name"]
                )
            await self._publish_iceberg(schedule, run)

        async with async_session() as session:
            started = await launch_dbt_run(
                request,
                str(schedule["created_by"]),
                session=session,
                on_complete=on_complete,
            )
            await session.execute(
                text(
                    """
                    UPDATE dbt_schedules
                    SET last_run_at = :at, last_run_id = CAST(:rid AS uuid),
                        last_status = 'running'
                    WHERE id = CAST(:sid AS uuid)
                    """
                ),
                {"at": now, "rid": started["run_id"], "sid": schedule_id},
            )
            await session.commit()

        logger.info(
            "Schedule '%s' started run %s (next %s)",
            schedule["name"],
            started["run_id"],
            upcoming,
        )
        return True

    @staticmethod
    async def _publish_iceberg(schedule: Dict[str, Any], run: Dict[str, Any]) -> None:
        """Bring the project's Iceberg tables in step after a successful run.

        Does nothing unless the schedule asked for it *and* the run succeeded:
        publishing the output of a failed run hands external readers a
        half-built mart layer. The check lives here rather than at the call
        site so it travels with the thing it guards.

        Failure here is logged, never raised. The dbt run has already been
        recorded as successful, and it *was* - the models are in the lake. A
        failed publish means the Iceberg copy is stale, which is the next run's
        problem, not a reason to report the run as broken.
        """
        if not schedule.get("publish_schema") or run.get("status") != "success":
            return
        schema = str(schedule["publish_schema"])
        try:
            result = await asyncio.to_thread(
                iceberg.publish, str(schedule["project_id"]), schema=schema
            )
            logger.info(
                "Schedule '%s' published %s to Iceberg: %s",
                schedule["name"],
                schema,
                result.get("published"),
            )
        except Exception as exc:
            logger.warning(
                "Schedule '%s' ran but could not publish %s to Iceberg: %s",
                schedule["name"],
                schema,
                exc,
            )

    @staticmethod
    async def _record_outcome(schedule_id: str, run: Dict[str, Any]) -> None:
        async with async_session() as session:
            await session.execute(
                text(
                    "UPDATE dbt_schedules SET last_status = :status "
                    "WHERE id = CAST(:sid AS uuid)"
                ),
                {"status": run.get("status") or "unknown", "sid": schedule_id},
            )
            await session.commit()

    # --- maintenance ----------------------------------------------------

    async def _maintenance_due(self, now: datetime) -> bool:
        """True at most once per MAINTENANCE_INTERVAL_HOURS, across processes."""
        interval = max(1, settings.maintenance_interval_hours) * 3600
        try:
            redis = await get_redis()
            # The key's presence *is* the "done recently" record: it expires
            # exactly when the next run becomes due.
            return bool(
                await redis.set(MAINTENANCE_KEY, self._instance, nx=True, ex=interval)
            )
        except Exception:
            if self._last_maintenance and (
                now - self._last_maintenance
            ).total_seconds() < interval:
                return False
            self._last_maintenance = now
            return True

    async def _run_maintenance(self) -> None:
        logger.info("Running scheduled maintenance")
        try:
            pruned = await self.prune_run_history()
            if pruned:
                logger.info("Pruned %s run rows past the retention window", pruned)
        except Exception as exc:
            logger.warning("Run history prune failed: %s", exc)

        try:
            await self.maintain_lakehouses()
        except Exception as exc:
            logger.warning("Lakehouse maintenance failed: %s", exc)

    @staticmethod
    async def prune_run_history() -> int:
        """Delete terminal run rows older than the retention window."""
        days = settings.run_history_retention_days
        if days <= 0:
            return 0
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        deleted = 0
        async with async_session() as session:
            # dbt_run_artifacts cascade from dbt_runs, so one delete covers both.
            result = await session.execute(
                text(
                    "DELETE FROM dbt_runs "
                    "WHERE created_at < :cutoff AND status = ANY(:statuses)"
                ),
                {"cutoff": cutoff, "statuses": list(_TERMINAL_STATUSES)},
            )
            deleted += result.rowcount or 0

            exists = await session.execute(
                text("SELECT to_regclass('ingest_runs') IS NOT NULL")
            )
            if exists.scalar():
                result = await session.execute(
                    text(
                        "DELETE FROM ingest_runs "
                        "WHERE created_at < :cutoff AND status = ANY(:statuses)"
                    ),
                    {"cutoff": cutoff, "statuses": list(_TERMINAL_STATUSES)},
                )
                deleted += result.rowcount or 0
            await session.commit()
        return deleted

    @staticmethod
    async def maintain_lakehouses() -> Dict[str, Any]:
        """Expire snapshots and delete dead files for every ingesting project."""
        days = settings.lake_snapshot_retention_days
        if days <= 0 or not lakehouse.is_configured():
            return {}

        async with async_session() as session:
            exists = await session.execute(
                text("SELECT to_regclass('ingest_sources') IS NOT NULL")
            )
            if not exists.scalar():
                return {}
            result = await session.execute(
                text(
                    """
                    SELECT DISTINCT s.project_id
                    FROM ingest_sources s
                    JOIN dbt_projects p ON p.id = s.project_id
                    WHERE s.destination = 'ducklake' AND p.deleted_at IS NULL
                    """
                )
            )
            project_ids = [str(row[0]) for row in result.all()]

        outcomes: Dict[str, Any] = {}
        for project_id in project_ids:
            try:
                # Serialise against this project's dbt runs and DuckDB-writing
                # ingests. A busy project is skipped, not queued behind.
                async with AsyncFileLock.lock(project_id, "dbt_run", timeout=30):
                    outcomes[project_id] = await asyncio.to_thread(
                        lakehouse.maintain, project_id, retention_days=days
                    )
            except TimeoutError:
                logger.info(
                    "Lake maintenance skipped for %s - project busy", project_id
                )
            except Exception as exc:
                logger.warning("Lake maintenance failed for %s: %s", project_id, exc)
                outcomes[project_id] = {"error": str(exc)}
        return outcomes


run_scheduler = RunScheduler()
