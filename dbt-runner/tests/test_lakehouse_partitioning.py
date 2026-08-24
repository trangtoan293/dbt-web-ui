"""Partition terms reach DuckLake as DDL, not as bound parameters.

`ALTER TABLE ... SET PARTITIONED BY (expr)` takes an expression, so the term
cannot be parameterised - it is concatenated into a statement. It originates in
a request body, which makes this validator the only thing between a user and the
catalog. It is also the knob that decides whether a date filter reads one month
of Parquet or the whole table.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest import lakehouse


class PartitionExpressionTests(unittest.TestCase):
    def test_bare_column_is_quoted(self):
        self.assertEqual(lakehouse.partition_expression("created_at"), '"created_at"')

    def test_date_part_functions_are_allowed(self):
        for term, expected in (
            ("year(created_at)", 'year("created_at")'),
            ("month(ORDER_DATE)", 'month("ORDER_DATE")'),
            ("DAY(ts)", 'day("ts")'),
            ("hour(ts)", 'hour("ts")'),
        ):
            with self.subTest(term=term):
                self.assertEqual(lakehouse.partition_expression(term), expected)

    def test_whitespace_is_tolerated(self):
        self.assertEqual(lakehouse.partition_expression("  month(ts) "), 'month("ts")')

    def test_injection_attempts_are_refused(self):
        for term in (
            "ts) ; DROP TABLE lake.raw.orders --",
            'ts") , ("x',
            "substr(ts, 1, 4)",
            "now()",
            "a + b",
            "*",
            "",
            "1",
            "ts)",
            "month(ts",
        ):
            with self.subTest(term=term):
                with self.assertRaises(lakehouse.LakehouseError):
                    lakehouse.partition_expression(term)

    def test_unknown_function_is_refused(self):
        # A function that exists in DuckDB but is not on the list still loses:
        # the allowlist is what makes concatenation safe.
        with self.assertRaises(lakehouse.LakehouseError):
            lakehouse.partition_expression("strftime(ts)")


class MaintenanceTests(unittest.TestCase):
    def test_small_files_are_merged_before_snapshots_expire(self):
        # Appending loads leave many small Parquet files and a scan pays per
        # file. Merging is what makes the old ones unreferenced, so it has to run
        # before expiry - the other order keeps the small files another window.
        names = [name for name, _ in lakehouse._MAINTENANCE_STEPS]
        self.assertIn("merge_adjacent_files", names)
        self.assertLess(
            names.index("merge_adjacent_files"), names.index("expire_snapshots")
        )


class UnpartitionedReportingTests(unittest.TestCase):
    """A mart with no partition spec is scanned whole. That must not be silent.

    An ingest source can carry a partition spec; a table dbt built cannot -
    nothing in this codebase gets to choose its layout. So marts, the most
    queried tables in the lake, are the ones most likely to be unpartitioned.
    Maintenance reports them; only the model's author can fix them.
    """

    def _lake(self, tmp):
        import duckdb

        connection = duckdb.connect()
        connection.execute("INSTALL ducklake")
        connection.execute("LOAD ducklake")
        connection.execute(
            f"ATTACH 'ducklake:sqlite:{tmp}/c.sqlite' AS lake (DATA_PATH '{tmp}/data/')"
        )
        # Same as lakehouse.provision: without this DuckLake inlines small writes
        # into the catalog instead of Parquet, so file_count stays 0 and this test
        # would pass against a table that has no files to be unpartitioned about.
        connection.execute("CALL lake.set_option('data_inlining_row_limit', 0)")
        return connection

    def test_a_many_file_table_without_a_partition_spec_is_reported(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            c = self._lake(tmp)
            c.execute("CREATE TABLE lake.wide AS SELECT range AS id FROM range(10)")
            for start in range(10, 60, 10):
                c.execute(f"INSERT INTO lake.wide SELECT range FROM range({start}, {start + 10})")

            reported = dict(lakehouse.unpartitioned_tables(c, min_files=2))

            self.assertIn("wide", reported)
            self.assertGreaterEqual(reported["wide"], 2)

    def test_a_partitioned_table_is_not_reported(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            c = self._lake(tmp)
            c.execute("CREATE TABLE lake.parted AS SELECT range AS id, range%7 AS d FROM range(100)")
            c.execute('ALTER TABLE lake.parted SET PARTITIONED BY ("d")')
            c.execute("INSERT INTO lake.parted SELECT range, range%7 FROM range(100, 200)")

            reported = dict(lakehouse.unpartitioned_tables(c, min_files=1))

            self.assertNotIn("parted", reported)

    def test_dbt_backup_tables_are_not_reported(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            c = self._lake(tmp)
            c.execute("CREATE TABLE lake.x__dbt_backup AS SELECT range AS id FROM range(10)")
            c.execute("INSERT INTO lake.x__dbt_backup SELECT range FROM range(10, 20)")

            self.assertEqual(lakehouse.unpartitioned_tables(c, min_files=1), [])

    def test_a_broken_introspection_returns_empty_rather_than_failing_maintenance(self):
        class Boom:
            def execute(self, *_):
                raise RuntimeError("no such metadata table in this build")

        self.assertEqual(lakehouse.unpartitioned_tables(Boom()), [])


if __name__ == "__main__":
    unittest.main()
