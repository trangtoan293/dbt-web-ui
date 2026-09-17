"""What _apply_lakehouse_attach puts in a profile, and when.

The lake a project uses is a row it points at, not something derived from its
own id - so a project can read a lake it never ingests into, and several
projects can share one. Two things must stay true: a project with no lake gains
no attach block (attaching opens a catalog connection on every dbt invocation),
and a project *with* one on a warehouse that cannot read it fails loudly rather
than leaving every model to fail with "not found within 'lake'".
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.dbt_service import DbtOperationError, DbtService
from ingest import lakehouse
from ingest.lakehouse import LakehouseError

LAKE = lakehouse.LakeRef(
    catalog_url="postgresql://u:s3cret@catalog:5432/db",
    data_path="/data/storage/lake/abc",
    metadata_schema="lake_abc",
)


def _session():
    session = MagicMock()
    session.execute = AsyncMock()
    session.rollback = AsyncMock()
    return session


class LakehouseAttachTest(unittest.TestCase):
    """Per target: the lake goes on the targets that can hold it, and no others."""

    def test_a_project_without_a_lake_gets_no_attach(self):
        config = {}
        env = DbtService._apply_lakehouse_attach(None, "duckdb", config)
        self.assertEqual(env, {})
        self.assertNotIn("attach", config)

    def test_an_attached_lake_adds_attach_and_password_env(self):
        config = {"extensions": ["httpfs"]}
        env = DbtService._apply_lakehouse_attach(LAKE, "duckdb", config)

        self.assertEqual(env, {lakehouse.CATALOG_PASSWORD_ENV: "s3cret"})
        self.assertEqual(config["extensions"], ["httpfs", "ducklake", "postgres"])
        attached = config["attach"][0]
        self.assertEqual(attached["alias"], "lake")
        self.assertEqual(attached["options"]["metadata_schema"], "lake_abc")
        # The secret reaches dbt through the environment, never through the file.
        self.assertNotIn("s3cret", attached["path"])

    def test_a_non_duckdb_target_is_skipped_not_refused(self):
        """A dev on DuckDB beside a prod on Dremio is an ordinary project.

        Refusing here failed the whole profile - and therefore every dbt command
        - for a project whose lake target was perfectly fine.
        """
        config = {}
        env = DbtService._apply_lakehouse_attach(LAKE, "dremio", config)
        self.assertEqual(env, {})
        self.assertNotIn("attach", config)


class LakehouseResolutionTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_missing_lake_row_fails_the_profile_rather_than_the_models(self):
        with patch(
            "app.services.dbt_service.resolve_project_lake",
            AsyncMock(side_effect=LakehouseError("no longer exists")),
        ):
            with self.assertRaises(DbtOperationError):
                await DbtService._resolve_lakehouse(_session(), "p1")

    async def test_no_lake_resolves_to_none(self):
        with patch(
            "app.services.dbt_service.resolve_project_lake",
            AsyncMock(return_value=None),
        ):
            self.assertIsNone(await DbtService._resolve_lakehouse(_session(), "p1"))


class WarmWorkerReleaseTest(unittest.IsolatedAsyncioTestCase):
    """A warm worker holding the DuckDB file makes the second dbt run fail.

    `Could not set lock on file ... Conflicting lock is held` - the first run
    succeeds, every later one does not, because a warm worker keeps a dbt process
    (and therefore the file) open. The profile regeneration step hands the file
    back, since it is the one place every dbt invocation passes through.
    """

    async def test_release_stops_only_the_named_project(self):
        from app.services.dbt_worker import DbtWarmWorkerPool

        pool = DbtWarmWorkerPool()
        stopped = []

        class FakePool:
            def __init__(self, name):
                self.name = name

            async def stop(self):
                stopped.append(self.name)

        pool._project_pools = {"p1": FakePool("p1"), "p2": FakePool("p2")}

        self.assertTrue(await pool.release_project("p1"))
        self.assertEqual(stopped, ["p1"])
        self.assertNotIn("p1", pool._project_pools)
        self.assertIn("p2", pool._project_pools)

    async def test_release_is_a_no_op_for_an_unknown_project(self):
        from app.services.dbt_worker import DbtWarmWorkerPool

        pool = DbtWarmWorkerPool()
        self.assertFalse(await pool.release_project("never-started"))

if __name__ == "__main__":
    unittest.main()
