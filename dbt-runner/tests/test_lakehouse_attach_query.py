"""_apply_lakehouse_attach must not disturb the session it borrows.

It runs inside the same transaction as the rest of a dbt request, where
resolve_user_id may already have updated `users.oidc_sub`. A failed statement
aborts a Postgres transaction, so probing for a table that does not exist yet -
every deployment before the ingest migration - must not be done by letting the
query fail and rolling back.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.dbt_service import DbtService


def _session(*results):
    """A session whose execute() returns the given results in order."""
    session = MagicMock()
    session.execute = AsyncMock(side_effect=list(results))
    session.rollback = AsyncMock()
    return session


def _result(scalar=None, first=None):
    result = MagicMock()
    result.scalar.return_value = scalar
    result.first.return_value = first
    return result


class LakehouseAttachQueryTest(unittest.IsolatedAsyncioTestCase):
    async def test_missing_table_does_not_roll_the_session_back(self):
        session = _session(_result(scalar=False))
        config = {}
        with patch("app.services.dbt_service.lakehouse") as lake:
            lake.is_configured.return_value = True
            env = await DbtService._apply_lakehouse_attach(
                session, "p1", "duckdb", config
            )

        self.assertEqual(env, {})
        self.assertEqual(config, {}, "no attach block for a deployment without the table")
        session.rollback.assert_not_awaited()

    async def test_project_without_a_lake_source_gets_no_attach(self):
        session = _session(_result(scalar=True), _result(first=None))
        config = {}
        with patch("app.services.dbt_service.lakehouse") as lake:
            lake.is_configured.return_value = True
            env = await DbtService._apply_lakehouse_attach(
                session, "p1", "duckdb", config
            )

        self.assertEqual(env, {})
        self.assertNotIn("attach", config)

    async def test_lake_source_adds_attach_and_password_env(self):
        session = _session(_result(scalar=True), _result(first=(1,)))
        config = {"extensions": ["httpfs"]}
        with patch("app.services.dbt_service.lakehouse") as lake:
            lake.is_configured.return_value = True
            lake.DUCKDB_EXTENSIONS = ("ducklake", "postgres")
            lake.CATALOG_PASSWORD_ENV = "DBT_ENV_SECRET_LAKE_CATALOG_PASSWORD"
            lake.dbt_attach_entry.return_value = {"alias": "lake"}
            lake.catalog_password.return_value = "s3cret"
            env = await DbtService._apply_lakehouse_attach(
                session, "p1", "duckdb", config
            )

        self.assertEqual(env, {"DBT_ENV_SECRET_LAKE_CATALOG_PASSWORD": "s3cret"})
        self.assertEqual(config["attach"], [{"alias": "lake"}])
        self.assertEqual(config["extensions"], ["httpfs", "ducklake", "postgres"])

    async def test_non_duckdb_project_never_queries_at_all(self):
        session = _session()
        with patch("app.services.dbt_service.lakehouse") as lake:
            lake.is_configured.return_value = True
            env = await DbtService._apply_lakehouse_attach(session, "p1", "postgresql", {})

        self.assertEqual(env, {})
        session.execute.assert_not_awaited()



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
