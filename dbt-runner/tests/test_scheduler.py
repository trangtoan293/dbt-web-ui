"""Scheduler arithmetic: when a cron fires, and when a due time is too old.

Both decisions are made without touching the database, which is the point -
firing logic that needs a live Postgres to test is firing logic nobody tests.
"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.scheduler import RunScheduler, is_misfire, next_fire_time


class NextFireTimeTest(unittest.TestCase):
    def test_returns_the_next_matching_minute_in_utc(self):
        after = datetime(2026, 1, 1, 10, 3, tzinfo=timezone.utc)
        self.assertEqual(
            next_fire_time("*/5 * * * *", after),
            datetime(2026, 1, 1, 10, 5, tzinfo=timezone.utc),
        )

    def test_daily_expression_crosses_midnight(self):
        after = datetime(2026, 1, 1, 23, 0, tzinfo=timezone.utc)
        self.assertEqual(
            next_fire_time("30 2 * * *", after),
            datetime(2026, 1, 2, 2, 30, tzinfo=timezone.utc),
        )

    def test_naive_input_is_read_as_utc(self):
        self.assertEqual(
            next_fire_time("0 * * * *", datetime(2026, 1, 1, 10, 30)),
            datetime(2026, 1, 1, 11, 0, tzinfo=timezone.utc),
        )

    def test_unparseable_expression_returns_none_instead_of_raising(self):
        # One typo must not stop every other schedule in the deployment.
        self.assertIsNone(next_fire_time("not a cron", datetime.now(timezone.utc)))
        self.assertIsNone(next_fire_time("", datetime.now(timezone.utc)))
        self.assertIsNone(next_fire_time("99 * * * *", datetime.now(timezone.utc)))


class MisfireTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)

    def test_recent_due_time_is_not_a_misfire(self):
        self.assertFalse(is_misfire(self.now - timedelta(seconds=30), self.now, 3600))

    def test_stale_due_time_is_a_misfire(self):
        self.assertTrue(is_misfire(self.now - timedelta(hours=9), self.now, 3600))

    def test_unset_due_time_is_never_a_misfire(self):
        self.assertFalse(is_misfire(None, self.now, 3600))

    def test_naive_due_time_is_read_as_utc(self):
        self.assertTrue(is_misfire(datetime(2026, 1, 1, 2, 0), self.now, 3600))


class PruneTest(unittest.IsolatedAsyncioTestCase):
    async def test_retention_of_zero_deletes_nothing(self):
        # 0 means "keep everything" - it must not become "delete everything".
        with patch("app.services.scheduler.settings") as config:
            config.run_history_retention_days = 0
            with patch("app.services.scheduler.async_session") as session_factory:
                deleted = await RunScheduler.prune_run_history()
        self.assertEqual(deleted, 0)
        session_factory.assert_not_called()

    async def test_prune_only_touches_terminal_rows(self):
        session = MagicMock()
        result = MagicMock()
        result.rowcount = 3
        result.scalar.return_value = False  # no ingest_runs table in this deployment
        session.execute = AsyncMock(return_value=result)
        session.commit = AsyncMock()
        session_ctx = MagicMock()
        session_ctx.__aenter__ = AsyncMock(return_value=session)
        session_ctx.__aexit__ = AsyncMock(return_value=False)

        with patch("app.services.scheduler.settings") as config:
            config.run_history_retention_days = 30
            with patch(
                "app.services.scheduler.async_session", return_value=session_ctx
            ):
                deleted = await RunScheduler.prune_run_history()

        self.assertEqual(deleted, 3)
        statements = [str(call.args[0]) for call in session.execute.await_args_list]
        delete_statements = [s for s in statements if "DELETE FROM dbt_runs" in s]
        self.assertEqual(len(delete_statements), 1)
        self.assertIn("status = ANY", delete_statements[0])

    async def test_lake_maintenance_is_skipped_when_disabled(self):
        with patch("app.services.scheduler.settings") as config:
            config.lake_snapshot_retention_days = 0
            with patch("app.services.scheduler.lakehouse") as lake:
                outcomes = await RunScheduler.maintain_lakehouses()
        self.assertEqual(outcomes, {})
        lake.maintain.assert_not_called()


class IcebergPublishOnScheduleTest(unittest.IsolatedAsyncioTestCase):
    """Publishing after a scheduled run, and the two ways it must not misfire."""

    SCHEDULE = {
        "id": "s1",
        "name": "nightly",
        "project_id": "3f8b1c2d-0000-4000-8000-abcdefabcdef",
        "publish_schema": "marts",
    }

    async def test_successful_run_publishes_the_named_schema(self):
        with patch("app.services.scheduler.iceberg") as ice:
            ice.publish.return_value = {"published": {"orders": "incremental: +1 file(s)"}}
            await RunScheduler._publish_iceberg(self.SCHEDULE, {"status": "success"})
        ice.publish.assert_called_once()
        self.assertEqual(ice.publish.call_args.kwargs["schema"], "marts")

    async def test_a_failed_run_publishes_nothing(self):
        # Publishing a failed run's output hands external readers a half-built
        # mart layer, and they cannot tell.
        with patch("app.services.scheduler.iceberg") as ice:
            await RunScheduler._publish_iceberg(self.SCHEDULE, {"status": "error"})
        ice.publish.assert_not_called()

    async def test_a_schedule_without_publish_schema_publishes_nothing(self):
        with patch("app.services.scheduler.iceberg") as ice:
            await RunScheduler._publish_iceberg(
                {**self.SCHEDULE, "publish_schema": None}, {"status": "success"}
            )
        ice.publish.assert_not_called()

    async def test_a_publish_failure_does_not_raise(self):
        # The dbt run already succeeded and the models are in the lake. A stale
        # Iceberg copy is the next run's problem, not a reason to report the run
        # as broken - raising here would do exactly that.
        with patch("app.services.scheduler.iceberg") as ice:
            ice.publish.side_effect = RuntimeError("catalog unreachable")
            await RunScheduler._publish_iceberg(self.SCHEDULE, {"status": "success"})


if __name__ == "__main__":
    unittest.main()
