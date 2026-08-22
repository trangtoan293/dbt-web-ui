"""Publishing lake marts as Iceberg, and the two things that make it safe.

1. The Parquet is copied. Registering the lake's own files costs no rewrite but
   DuckLake maintenance rewrites and then deletes them, and DuckLake cannot see
   an Iceberg table pointing at them - the published table breaks with
   FileNotFoundError. Two catalogs with two garbage collectors cannot share files.
2. An appended table publishes incrementally. Copying every file after every dbt
   run would make the publish cost scale with the table, not with the change.

Uses a SQLite catalog and a local warehouse, so it needs no running services.
"""

import shutil
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest import iceberg, lakehouse

PROJECT_ID = "3f8b1c2d-0000-4000-8000-abcdefabcdef"


class IcebergPublishTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

        catalog = f"sqlite:///{root}/lake_catalog.sqlite"
        self._lake = patch.object(lakehouse, "settings")
        lake_settings = self._lake.start()
        self.addCleanup(self._lake.stop)
        lake_settings.lake_catalog_url = catalog
        lake_settings.lake_data_dir = str(root / "lake")
        lake_settings.storage_dir = str(root)
        lake_settings.lake_inline_row_limit = 0

        self._ice = patch.object(iceberg, "settings")
        ice_settings = self._ice.start()
        self.addCleanup(self._ice.stop)
        ice_settings.iceberg_catalog_url = f"sqlite:///{root}/iceberg_catalog.sqlite"
        ice_settings.iceberg_warehouse_dir = str(root / "iceberg")
        ice_settings.storage_dir = str(root)

        # A SQLite catalog cannot create schemas, so the metadata lives in `main`
        # - the same thing tests/test_ingest_lakehouse.py does. Per-project
        # isolation is covered by test_projects_do_not_collide_in_one_catalog.
        self._schema = patch.object(lakehouse, "metadata_schema", return_value="main")
        self._schema.start()
        self.addCleanup(self._schema.stop)

        lakehouse.provision(
            catalog=catalog,
            data_path=str(lakehouse.data_dir(PROJECT_ID)),
            metadata=lakehouse.metadata_schema(PROJECT_ID),
            inline_row_limit=0,
        )
        self.connection = self._lake_connection()
        self.addCleanup(self.connection.close)
        self.connection.execute("CREATE SCHEMA IF NOT EXISTS lake.marts")

    def _lake_connection(self):
        import duckdb

        connection = duckdb.connect()
        for extension in lakehouse.DUCKDB_EXTENSIONS:
            connection.execute(f"LOAD {extension}")
        connection.execute(
            f"ATTACH IF NOT EXISTS '{lakehouse.attach_string(lakehouse.catalog_url())}' "
            f"AS lake (METADATA_SCHEMA '{lakehouse.metadata_schema(PROJECT_ID)}')"
        )
        return connection

    def _iceberg_rows(self, table: str = "orders") -> int:
        identifier = (*iceberg.namespace(PROJECT_ID, "marts"), table)
        return iceberg.catalog(PROJECT_ID).load_table(identifier).scan().to_arrow().num_rows

    def _copied_files(self, table: str = "orders") -> list:
        return sorted(p.name for p in iceberg._copy_dir(PROJECT_ID, "marts", table).glob("*.parquet"))

    # --- the question this feature exists to answer -----------------------

    def test_appending_a_mart_publishes_only_the_new_parquet(self):
        self.connection.execute(
            "CREATE TABLE lake.marts.orders AS SELECT range AS id FROM range(1000)"
        )
        first = iceberg.publish(PROJECT_ID, schema="marts")
        self.assertTrue(first["published"]["orders"].startswith("full:"), first)
        after_first = self._copied_files()
        self.assertEqual(self._iceberg_rows(), 1000)

        # A second dbt run that appends - an incremental model.
        self.connection.execute(
            "INSERT INTO lake.marts.orders SELECT range FROM range(1000, 1500)"
        )
        second = iceberg.publish(PROJECT_ID, schema="marts")

        self.assertTrue(
            second["published"]["orders"].startswith("incremental: +"),
            f"a re-publish after an append must not rewrite the table: {second}",
        )
        self.assertEqual(self._iceberg_rows(), 1500)
        # The files from the first publish were kept, not recopied.
        self.assertTrue(set(after_first) <= set(self._copied_files()))

    def test_republishing_an_unchanged_mart_copies_nothing(self):
        self.connection.execute(
            "CREATE TABLE lake.marts.orders AS SELECT range AS id FROM range(100)"
        )
        iceberg.publish(PROJECT_ID, schema="marts")
        before = self._copied_files()

        again = iceberg.publish(PROJECT_ID, schema="marts")

        self.assertEqual(again["published"]["orders"], "unchanged")
        self.assertEqual(before, self._copied_files())

    def test_a_rebuilt_mart_is_replaced_not_appended(self):
        # dbt's `table` materialization drops and recreates, so the lake's file
        # set is not a superset of what was published. Appending would double
        # the rows; this must be a full refresh.
        self.connection.execute(
            "CREATE TABLE lake.marts.orders AS SELECT range AS id FROM range(1000)"
        )
        iceberg.publish(PROJECT_ID, schema="marts")
        self.connection.execute("DROP TABLE lake.marts.orders")
        self.connection.execute(
            "CREATE TABLE lake.marts.orders AS SELECT range AS id FROM range(42)"
        )

        result = iceberg.publish(PROJECT_ID, schema="marts")

        self.assertTrue(result["published"]["orders"].startswith("full:"), result)
        self.assertEqual(self._iceberg_rows(), 42)

    # --- safety ----------------------------------------------------------

    def test_published_table_survives_lake_maintenance(self):
        # The reason the Parquet is copied at all. Registering the lake's files
        # in place passes this test's first half and fails the second.
        self.connection.execute(
            "CREATE TABLE lake.marts.orders AS SELECT range AS id FROM range(500)"
        )
        self.connection.execute(
            "INSERT INTO lake.marts.orders SELECT range FROM range(500, 1000)"
        )
        iceberg.publish(PROJECT_ID, schema="marts")
        self.assertEqual(self._iceberg_rows(), 1000)

        self.connection.execute("CALL ducklake_merge_adjacent_files('lake')")
        self.connection.execute(
            "CALL ducklake_expire_snapshots('lake', older_than => now() + INTERVAL '1 day')"
        )
        self.connection.execute("CALL ducklake_cleanup_old_files('lake', cleanup_all => true)")

        self.assertEqual(
            self._iceberg_rows(),
            1000,
            "lake maintenance deleted the files the Iceberg table points at",
        )

    def test_warehouse_is_outside_the_lake_data_directory(self):
        # Inside it, ducklake_delete_orphaned_files would find these copies
        # unreferenced and delete the published tables.
        lake_dir = lakehouse.data_dir(PROJECT_ID).resolve()
        warehouse = iceberg.warehouse_dir(PROJECT_ID).resolve()
        self.assertFalse(
            str(warehouse).startswith(str(lake_dir)),
            f"{warehouse} is inside {lake_dir}",
        )

    def test_dbt_backup_tables_are_not_published(self):
        self.connection.execute("CREATE TABLE lake.marts.orders AS SELECT 1 AS id")
        self.connection.execute(
            "CREATE TABLE lake.marts.orders__dbt_backup AS SELECT 1 AS id"
        )
        result = iceberg.publish(PROJECT_ID, schema="marts")
        self.assertEqual(list(result["published"]), ["orders"])

    def test_unknown_table_is_refused_rather_than_silently_skipped(self):
        self.connection.execute("CREATE TABLE lake.marts.orders AS SELECT 1 AS id")
        with self.assertRaises(iceberg.IcebergPublishError):
            iceberg.publish(PROJECT_ID, schema="marts", tables=["nope"])

    def test_projects_do_not_collide_in_one_catalog(self):
        other = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa"
        self.assertNotEqual(
            iceberg.namespace(PROJECT_ID, "marts"), iceberg.namespace(other, "marts")
        )


if __name__ == "__main__":
    unittest.main()
