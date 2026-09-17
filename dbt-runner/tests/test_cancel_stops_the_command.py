"""Stop must stop, not restart the command as a subprocess.

CommandService only ever knew the subprocess fallback, so /process/cancel did
nothing at all for a dbt command running in this project's warm worker - the
normal path. Killing the worker alone is not enough either: the caller in flight
reads a dead worker as a worker failure and re-runs the whole command, so Stop
made the command slower instead of stopping it.
"""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.dbt_worker import DbtWarmWorkerError, DbtWarmWorkerPool
from app.services.dbt_service import DbtService


class _Pool:
    """A worker pool whose run() blocks until the test cancels the project."""

    def __init__(self):
        self.real = DbtWarmWorkerPool()
        self.fell_back = False
        self.running = asyncio.Event()

    def cancellation_epoch(self, project_id):
        return self.real.cancellation_epoch(project_id)

    async def run(self, args, project_path, *, project_id, env=None):
        self.running.set()
        await asyncio.sleep(0.05)
        raise DbtWarmWorkerError("worker died")


class CancelStopsTheCommand(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pool = _Pool()
        self.service = DbtService(worker_pool=self.pool)
        # A subprocess fallback here would run a real dbt; record the attempt instead.
        async def _no_subprocess(*_args, **_kwargs):
            self.pool.fell_back = True
            return 0, "ran anyway", ""
        self.service._run_dbt_subprocess = _no_subprocess

    async def test_a_cancelled_command_returns_cancelled_and_does_not_re_run(self):
        async def cancel_once_running():
            await self.pool.running.wait()
            await self.pool.real.release_project("p1", cancel=True)

        task = asyncio.create_task(cancel_once_running())
        returncode, _stdout, stderr = await self.service._run_dbt_command(
            ["dbt", "run"], Path("/tmp"), project_id="p1"
        )
        await task

        self.assertEqual(returncode, -1)
        self.assertIn("Cancelled", stderr)
        self.assertFalse(self.pool.fell_back, "Stop must not re-run the command")

    async def test_a_worker_that_simply_died_still_falls_back(self):
        returncode, stdout, _stderr = await self.service._run_dbt_command(
            ["dbt", "run"], Path("/tmp"), project_id="p2"
        )

        self.assertTrue(self.pool.fell_back)
        self.assertEqual(returncode, 0)
        self.assertEqual(stdout, "ran anyway")

    async def test_releasing_for_the_duckdb_lock_is_not_a_cancellation(self):
        """_regenerate_profiles_from_db releases a pool so a run can open its file."""
        pool = DbtWarmWorkerPool()
        before = pool.cancellation_epoch("p3")
        await pool.release_project("p3")
        self.assertEqual(pool.cancellation_epoch("p3"), before)
        await pool.release_project("p3", cancel=True)
        self.assertEqual(pool.cancellation_epoch("p3"), before + 1)


if __name__ == "__main__":
    unittest.main()
