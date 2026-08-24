"""Preview, compile and explain must honour the chosen target.

`--target` was appended only by the run path, so picking `prod` in the toolbar
and hitting Preview still queried `dev` - silently, because dbt reports whatever
target it used only in the log the preview never shows.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.dbt_service import InvalidTarget, append_target


class AppendTarget(unittest.TestCase):
    def test_no_target_leaves_the_command_alone(self):
        self.assertEqual(append_target(["dbt", "show"], None), ["dbt", "show"])
        self.assertEqual(append_target(["dbt", "show"], ""), ["dbt", "show"])

    def test_a_target_is_appended(self):
        self.assertEqual(
            append_target(["dbt", "show"], "prod"), ["dbt", "show", "--target", "prod"]
        )

    def test_the_original_command_is_not_mutated(self):
        cmd = ["dbt", "show"]
        append_target(cmd, "prod")
        self.assertEqual(cmd, ["dbt", "show"])

    def test_a_target_that_could_smuggle_an_argument_is_refused(self):
        for name in ("--profiles-dir", "prod --vars x", "PROD", "9prod", "a" * 31):
            with self.subTest(name=name), self.assertRaises(InvalidTarget):
                append_target(["dbt", "show"], name)


class RequestsCarryTarget(unittest.TestCase):
    def test_every_request_that_runs_dbt_accepts_one(self):
        from app.models.dbt import (
            CompileRequest,
            ExplainRequest,
            PreviewRequest,
            QueryRequest,
        )

        from app.models.docs import DocsGenerateRequest

        for model in (
            CompileRequest,
            ExplainRequest,
            PreviewRequest,
            QueryRequest,
            # docs generate reads the warehouse catalog: it documents whichever
            # target it ran against.
            DocsGenerateRequest,
        ):
            with self.subTest(model=model.__name__):
                self.assertIn("target", model.model_fields)


if __name__ == "__main__":
    unittest.main()
