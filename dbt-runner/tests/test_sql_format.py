"""Formatting model SQL must never change what the model does.

The formatter masks Jinja, hands the SQL to sqlglot, and puts the Jinja back.
Anything it cannot verify it refuses - these are the cases that make that
refusal trustworthy enough to bind to a keystroke.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.sql_format import format_sql


class FormatSqlTest(unittest.TestCase):
    def test_formats_plain_sql(self):
        result = format_sql("select a,b from t where a=1")
        self.assertTrue(result["formatted"])
        self.assertIn("SELECT", result["sql"])
        self.assertIn("FROM", result["sql"])

    def test_keeps_config_block_and_ref_intact(self):
        source = (
            "{{ config(materialized='table') }}\n"
            "select a, b from {{ ref('stg_orders') }} where a > 1"
        )
        result = format_sql(source)
        self.assertTrue(result["formatted"], result)
        self.assertIn("{{ config(materialized='table') }}", result["sql"])
        self.assertIn("{{ ref('stg_orders') }}", result["sql"])
        self.assertNotIn("__dbtcraft_jinja", result["sql"])

    def test_keeps_source_and_var_calls(self):
        result = format_sql(
            "select * from {{ source('raw','orders') }} "
            "where day >= '{{ var(\"start\") }}'"
        )
        self.assertTrue(result["formatted"], result)
        self.assertIn("{{ source('raw','orders') }}", result["sql"])
        self.assertIn('{{ var("start") }}', result["sql"])

    def test_jinja_control_flow_is_never_mangled(self):
        source = (
            "select * from t\n"
            "{% if var('x') %} where a = 1 {% else %} where a = 2 {% endif %}"
        )
        result = format_sql(source)
        # Either refused outright, or every branch survives. Silently dropping
        # the else branch would change results after templating.
        if result["formatted"]:
            for fragment in ("{% if var('x') %}", "{% else %}", "{% endif %}"):
                self.assertIn(fragment, result["sql"])
        else:
            self.assertEqual(result["sql"], source)

    def test_unparseable_sql_is_returned_unchanged_with_a_reason(self):
        result = format_sql("select from where")
        self.assertFalse(result["formatted"])
        self.assertEqual(result["sql"], "select from where")
        self.assertTrue(result["reason"])

    def test_empty_input_is_not_an_error(self):
        result = format_sql("   ")
        self.assertFalse(result["formatted"])
        self.assertEqual(result["sql"], "   ")

    def test_oversized_input_is_refused(self):
        result = format_sql("select 1 -- " + "x" * 300_000)
        self.assertFalse(result["formatted"])
        self.assertIn("larger than", result["reason"])

    def test_formatting_is_idempotent(self):
        once = format_sql("select a, b from {{ ref('m') }} where a=1")
        twice = format_sql(once["sql"])
        self.assertTrue(twice["formatted"], twice)
        self.assertEqual(once["sql"].strip(), twice["sql"].strip())


if __name__ == "__main__":
    unittest.main()
