"""A project with no connection still reaches a lakehouse it has attached.

"No connection (manual profiles.yml)" is the first option on the new-project
form, so it is what a fresh deployment gets by default. Such a project never
goes through target rendering, which is the only place `attach:` was added -
so ingest filled the lake and every `lake.*` reference in dbt stayed
unresolvable, with nothing reporting a problem.
"""

import sys
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.dbt_service import (
    PLACEHOLDER_HEADER,
    _attach_lake_to_placeholder_profile,
)
from ingest import lakehouse

LAKE = lakehouse.LakeRef(
    catalog_url="postgresql://cat:secret@catalog-host:5432/catalogdb",
    data_path="/data/storage/lake/abc",
    metadata_schema="lake_abc",
)

PLACEHOLDER = PLACEHOLDER_HEADER + yaml.safe_dump(
    {
        "proj": {
            "outputs": {"dev": {"type": "duckdb", "path": "dev.duckdb", "schema": "main"}},
            "target": "dev",
        }
    },
    sort_keys=False,
)


class PlaceholderLakeAttachTest(unittest.TestCase):
    def _write(self, tmp: Path, content: str) -> Path:
        (tmp / "profiles.yml").write_text(content)
        return tmp

    def setUp(self):
        import tempfile

        self.tmp = Path(tempfile.mkdtemp())

    def _outputs(self) -> dict:
        parsed = yaml.safe_load((self.tmp / "profiles.yml").read_text())
        return parsed["proj"]["outputs"]["dev"]

    def test_the_lake_is_attached_and_the_password_travels_by_env(self):
        self._write(self.tmp, PLACEHOLDER)
        env = _attach_lake_to_placeholder_profile(self.tmp, LAKE)

        output = self._outputs()
        self.assertEqual(len(output["attach"]), 1)
        self.assertEqual(output["attach"][0]["alias"], lakehouse.ATTACH_ALIAS)
        self.assertTrue(output["attach"][0]["is_ducklake"])
        self.assertEqual(
            output["attach"][0]["options"]["metadata_schema"], "lake_abc"
        )
        for extension in lakehouse.DUCKDB_EXTENSIONS:
            self.assertIn(extension, output["extensions"])

        # The secret reaches dbt through env_var(), never through the file.
        self.assertEqual(env, {lakehouse.CATALOG_PASSWORD_ENV: "secret"})
        self.assertNotIn("secret", (self.tmp / "profiles.yml").read_text())

    def test_it_is_idempotent_and_keeps_its_marker(self):
        self._write(self.tmp, PLACEHOLDER)
        _attach_lake_to_placeholder_profile(self.tmp, LAKE)
        _attach_lake_to_placeholder_profile(self.tmp, LAKE)

        content = (self.tmp / "profiles.yml").read_text()
        self.assertTrue(content.startswith(PLACEHOLDER_HEADER))
        # Re-running must not stack a second attach entry for the same alias.
        self.assertEqual(len(self._outputs()["attach"]), 1)

    def test_a_hand_edited_profile_is_left_alone(self):
        edited = "# my own profile\nproj:\n  outputs:\n    dev:\n      type: duckdb\n  target: dev\n"
        self._write(self.tmp, edited)
        env = _attach_lake_to_placeholder_profile(self.tmp, LAKE)

        self.assertEqual(env, {})
        self.assertEqual((self.tmp / "profiles.yml").read_text(), edited)


if __name__ == "__main__":
    unittest.main()
