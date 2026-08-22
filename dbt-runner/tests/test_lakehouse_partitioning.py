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


if __name__ == "__main__":
    unittest.main()
