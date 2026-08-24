"""Warm worker pools must not accumulate.

A pool is a set of live dbt processes. Each holds resident memory, its project's
DuckDB file, and - for a project that attaches the lake - a Postgres connection.
Pools are created per project on demand, and before reclamation existed they were
never removed: a deployment's cost grew with every project anyone had previewed,
which is also what made the per-instance memory limit stop bounding the machine.
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.dbt_worker import DbtWarmWorkerPool


def _fake_pool(project_id: str, *, in_use: int = 0, last_used: float = 0.0):
    pool = AsyncMock()
    pool.project_id = project_id
    pool.in_use = in_use
    pool.last_used = last_used
    pool.reclaimable = in_use == 0
    pool.idle_seconds = lambda: 10_000.0
    return pool


class ReclaimTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.pool = DbtWarmWorkerPool()
        self.pool._project_pools = {}

    async def test_idle_pools_are_stopped(self):
        idle = _fake_pool("old")
        self.pool._project_pools = {"old": idle}
        with patch("app.services.dbt_worker.settings") as config:
            config.dbt_warm_worker_idle_seconds = 900
            config.dbt_warm_worker_max_projects = 8
            await self.pool._reclaim_pools(keep="new")
        idle.stop.assert_awaited_once()
        self.assertNotIn("old", self.pool._project_pools)

    async def test_a_busy_pool_is_never_stopped(self):
        # Stopping a pool mid-job kills the command that triggered the sweep.
        busy = _fake_pool("busy", in_use=1)
        self.pool._project_pools = {"busy": busy}
        with patch("app.services.dbt_worker.settings") as config:
            config.dbt_warm_worker_idle_seconds = 1
            config.dbt_warm_worker_max_projects = 1
            await self.pool._reclaim_pools(keep="other")
        busy.stop.assert_not_awaited()
        self.assertIn("busy", self.pool._project_pools)

    async def test_the_project_about_to_run_survives_its_own_sweep(self):
        mine = _fake_pool("mine")
        self.pool._project_pools = {"mine": mine}
        with patch("app.services.dbt_worker.settings") as config:
            config.dbt_warm_worker_idle_seconds = 1
            config.dbt_warm_worker_max_projects = 1
            await self.pool._reclaim_pools(keep="mine")
        mine.stop.assert_not_awaited()

    async def test_over_the_project_limit_evicts_least_recently_used(self):
        pools = {
            "oldest": _fake_pool("oldest", last_used=1.0),
            "newer": _fake_pool("newer", last_used=50.0),
        }
        self.pool._project_pools = dict(pools)
        with patch("app.services.dbt_worker.settings") as config:
            config.dbt_warm_worker_idle_seconds = 0  # idle sweep off
            config.dbt_warm_worker_max_projects = 2
            await self.pool._reclaim_pools(keep="newer")
        pools["oldest"].stop.assert_awaited_once()
        pools["newer"].stop.assert_not_awaited()

    async def test_all_busy_over_the_limit_goes_over_rather_than_refusing(self):
        # Refusing the command would be worse than one extra live pool, and the
        # next sweep catches up.
        pools = {n: _fake_pool(n, in_use=1) for n in ("a", "b", "c")}
        self.pool._project_pools = dict(pools)
        with patch("app.services.dbt_worker.settings") as config:
            config.dbt_warm_worker_idle_seconds = 0
            config.dbt_warm_worker_max_projects = 1
            await asyncio.wait_for(self.pool._reclaim_pools(keep="d"), timeout=2)
        for p in pools.values():
            p.stop.assert_not_awaited()
        self.assertEqual(len(self.pool._project_pools), 3)


if __name__ == "__main__":
    unittest.main()
