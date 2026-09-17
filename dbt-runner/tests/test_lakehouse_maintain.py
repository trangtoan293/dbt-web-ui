"""lakehouse.maintain() against a real DuckLake catalog.

The point of these is that the SQL is actually accepted by the extension in the
image. Which `ducklake_*` maintenance functions exist varies by version, so
maintain() reports per-step outcomes instead of failing - and a test that mocked
duckdb would prove nothing about that.

Uses a SQLite catalog in a temp dir: no Postgres, no services. The metadata
schema is pinned to `main` here because SQLite cannot create schemas at all -
which is also why a real deployment's per-project metadata schema needs the
Postgres catalog.
"""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest import lakehouse

PROJECT_ID = "11111111-2222-3333-4444-555555555555"


def _duckdb_available() -> bool:
    try:
        import duckdb  # noqa: F401

        return True
    except Exception:
        return False


@unittest.skipUnless(_duckdb_available(), "duckdb not installed")
class MaintainTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="lake-maintain-"))
        self.catalog = f"sqlite:///{self.root / 'catalog.sqlite'}"
        self.data = self.root / "data"
        patcher = patch.object(
            lakehouse.settings,
            "lake_data_dir",
            str(self.data.parent / "lakeroot"),
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.root, True)

        catalog_patcher = patch.object(
            lakehouse, "_configured_catalog_url", return_value=self.catalog
        )
        catalog_patcher.start()
        self.addCleanup(catalog_patcher.stop)

        # SQLite has no CREATE SCHEMA, so the catalog lives in `main`.
        self.lake = lakehouse.LakeRef(
            catalog_url=self.catalog,
            data_path=str(lakehouse.data_dir(PROJECT_ID)),
            metadata_schema="main",
        )
        lakehouse.provision(self.lake, inline_row_limit=0)

    def _write_table(self, statement: str) -> None:
        import duckdb

        connection = duckdb.connect()
        try:
            for extension in lakehouse.DUCKDB_EXTENSIONS:
                connection.execute(f"LOAD {extension}")
            connection.execute(
                f"ATTACH IF NOT EXISTS '{lakehouse.attach_string(self.catalog)}' "
                f"AS {lakehouse.ATTACH_ALIAS} "
                f"(METADATA_SCHEMA '{self.lake.metadata_schema}')"
            )
            connection.execute(statement)
        finally:
            connection.close()

    def test_maintains_an_empty_catalog(self):
        outcomes = lakehouse.maintain(self.lake, retention_days=7)
        # Every step reports; a missing function is "skipped: ...", not a raise.
        self.assertIn("expire_snapshots", outcomes)
        self.assertIn("delete_orphaned_files", outcomes)
        self.assertEqual(outcomes["drop_dbt_backups"], "dropped 0")

    def test_expire_snapshots_is_accepted_by_the_installed_extension(self):
        self._write_table("CREATE TABLE lake.main.orders AS SELECT 1 AS id")
        self._write_table("INSERT INTO lake.main.orders SELECT 2")
        outcomes = lakehouse.maintain(self.lake, retention_days=0)
        self.assertEqual(
            outcomes["expire_snapshots"], "ok", msg=f"outcomes={outcomes}"
        )

    def test_drops_dbt_backup_tables_and_leaves_real_ones(self):
        self._write_table("CREATE TABLE lake.main.dim_customer AS SELECT 1 AS id")
        self._write_table(
            "CREATE TABLE lake.main.dim_customer__dbt_backup AS SELECT 1 AS id"
        )

        outcomes = lakehouse.maintain(self.lake, retention_days=7)
        self.assertEqual(outcomes["drop_dbt_backups"], "dropped 1")

        import duckdb

        connection = duckdb.connect()
        try:
            for extension in lakehouse.DUCKDB_EXTENSIONS:
                connection.execute(f"LOAD {extension}")
            connection.execute(
                f"ATTACH IF NOT EXISTS '{lakehouse.attach_string(self.catalog)}' "
                f"AS {lakehouse.ATTACH_ALIAS} "
                f"(METADATA_SCHEMA '{self.lake.metadata_schema}')"
            )
            remaining = {
                row[0]
                for row in connection.execute(
                    "SELECT table_name FROM duckdb_tables() WHERE database_name = ?",
                    [lakehouse.ATTACH_ALIAS],
                ).fetchall()
            }
        finally:
            connection.close()

        self.assertIn("dim_customer", remaining)
        self.assertNotIn("dim_customer__dbt_backup", remaining)

    def test_negative_retention_is_refused(self):
        with self.assertRaises(lakehouse.LakehouseError):
            lakehouse.maintain(self.lake, retention_days=-1)

    def test_an_unmaintained_lake_is_refused(self):
        """The guard is in maintain(), not in every caller that might forget it.

        cleanup_old_files deletes every file this catalog does not reference. On
        a lake somebody else also writes to, that is not the same as garbage -
        so a lake this deployment does not maintain never reaches the steps.
        """
        external = lakehouse.LakeRef(
            catalog_url=self.catalog,
            data_path=self.lake.data_path,
            metadata_schema="main",
            mode=lakehouse.MODE_EXTERNAL,
            maintained=False,
        )
        with self.assertRaises(lakehouse.LakehouseError):
            lakehouse.maintain(external, retention_days=7)

    def test_provision_does_not_pin_options_on_an_external_lake(self):
        """set_option writes to the catalog, changing how its owner writes too."""
        external = lakehouse.LakeRef(
            catalog_url="postgresql://nobody@nowhere.invalid:5432/db",
            data_path=self.lake.data_path,
            metadata_schema="main",
            mode=lakehouse.MODE_EXTERNAL,
        )
        # Unreachable on purpose: provision must return before touching it.
        lakehouse.provision(external)

    def test_destroy_refuses_an_external_lake(self):
        external = lakehouse.LakeRef(
            catalog_url=self.catalog,
            data_path=self.lake.data_path,
            metadata_schema="main",
            mode=lakehouse.MODE_EXTERNAL,
        )
        with self.assertRaises(lakehouse.LakehouseError):
            lakehouse.destroy(external)
        self.assertTrue(Path(self.lake.data_path).exists())


if __name__ == "__main__":
    unittest.main()
