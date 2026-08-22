"""Recording one ingest load.

Row counts come from the runner's `row_counts` field. Reading any other key
silently records every load as having moved nothing, which is worse than no
history at all - it looks like data and is not.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.routers.ingest import _RunRecorder, _rows_loaded


class RowsLoadedTest(unittest.TestCase):
    def test_sums_the_runner_row_counts(self):
        self.assertEqual(
            _rows_loaded({"row_counts": {"customers": 10, "orders": 15}}), 25
        )

    def test_missing_counts_is_unknown_not_zero(self):
        self.assertIsNone(_rows_loaded({}))
        self.assertIsNone(_rows_loaded({"row_counts": None}))
        self.assertIsNone(_rows_loaded({"tables": {"customers": 10}}))

    def test_ignores_non_numeric_entries(self):
        self.assertEqual(
            _rows_loaded({"row_counts": {"a": 5, "b": "many", "c": True}}), 5
        )

    def test_empty_counts_is_zero(self):
        self.assertEqual(_rows_loaded({"row_counts": {}}), 0)


def _session_factory(session):
    context = MagicMock()
    context.__aenter__ = AsyncMock(return_value=session)
    context.__aexit__ = AsyncMock(return_value=False)
    return MagicMock(return_value=context)


def _session():
    session = MagicMock()
    session.execute = AsyncMock()
    session.commit = AsyncMock()
    return session


class RecorderTest(unittest.IsolatedAsyncioTestCase):
    async def test_no_row_is_written_before_the_migration_is_applied(self):
        session = _session()
        result = MagicMock()
        result.scalar.return_value = False
        session.execute = AsyncMock(return_value=result)

        recorder = _RunRecorder("s1", "p1")
        with patch("app.routers.ingest.async_session", _session_factory(session)):
            await recorder.start()
            # finish() on an unrecorded run must be a no-op, not a crash.
            await recorder.finish("success", {"row_counts": {"t": 1}}, None)

        self.assertIsNone(recorder.run_id)

    async def test_log_tail_is_capped(self):
        recorder = _RunRecorder("s1", "p1")
        recorder.run_id = "r1"
        with patch("app.routers.ingest.settings") as config:
            config.ingest_run_log_max_chars = 50
            for index in range(1000):
                recorder.observe({"type": "log", "message": f"line {index}"})
            session = _session()
            with patch("app.routers.ingest.async_session", _session_factory(session)):
                await recorder.finish("success", {}, None)

        params = session.execute.await_args.args[1]
        self.assertLessEqual(len(params["logs"]), 50)

    async def test_only_log_events_are_captured(self):
        recorder = _RunRecorder("s1", "p1")
        recorder.run_id = "r1"
        with patch("app.routers.ingest.settings") as config:
            config.ingest_run_log_max_chars = 10_000
            recorder.observe({"type": "log", "message": "keep me"})
            recorder.observe({"type": "completed", "row_counts": {"t": 1}})
            recorder.observe({"type": "error", "message": "drop me"})
            session = _session()
            with patch("app.routers.ingest.async_session", _session_factory(session)):
                await recorder.finish("success", {}, None)

        logs = session.execute.await_args.args[1]["logs"]
        self.assertIn("keep me", logs)
        self.assertNotIn("drop me", logs)

    async def test_outcome_is_persisted_with_row_counts(self):
        recorder = _RunRecorder("s1", "p1")
        recorder.run_id = "r1"
        session = _session()
        with patch("app.routers.ingest.settings") as config:
            config.ingest_run_log_max_chars = 10_000
            with patch("app.routers.ingest.async_session", _session_factory(session)):
                await recorder.finish(
                    "success", {"row_counts": {"customers": 10}}, None
                )

        params = session.execute.await_args.args[1]
        self.assertEqual(params["status"], "success")
        self.assertEqual(params["rows_loaded"], 10)
        self.assertIn("customers", params["tables"])
        self.assertIsNotNone(params["duration_ms"])


if __name__ == "__main__":
    unittest.main()
