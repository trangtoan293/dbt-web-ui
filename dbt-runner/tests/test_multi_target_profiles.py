"""One project, several named targets in one profiles.yml.

The default target is the project's own connection and keeps the profile it
always had. Extra targets come from project_targets, and each needs its *own*
credential env var: sharing one name means whichever output is rendered last
wins and the other target authenticates against its warehouse with the wrong
password - a silent cross-environment write.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.dbt_service import (
    DBT_PROFILE_SECRET_ENV,
    DEFAULT_TARGET_NAME,
    DbtService,
)

_PROJECT_ROW = {
    "connection_id": "11111111-1111-1111-1111-111111111111",
    "dremio_source_id": None,
}


def _connection(host, database):
    return {
        "connection_type": "postgresql",
        "host": host,
        "port": 5432,
        "database": database,
        "username": "u",
        "password_encrypted": f"secret-for-{database}",
        "extra_config": None,
    }


class _Result:
    def __init__(self, *, row=None, rows=None, scalar=None):
        self._row = row
        self._rows = rows or []
        self._scalar = scalar

    def mappings(self):
        return self

    def first(self):
        return self._row

    def all(self):
        return self._rows

    def scalar(self):
        return self._scalar


class _Session:
    """Answers by statement shape, so query order is not baked into the test."""

    def __init__(self, *, targets, connections):
        self._targets = targets
        self._connections = connections
        self.commit = AsyncMock()

    async def execute(self, statement, params=None):
        sql = str(statement)
        if "to_regclass('project_targets')" in sql:
            return _Result(scalar=True)
        if "to_regclass" in sql:
            return _Result(scalar=False)
        if "FROM dbt_projects" in sql:
            return _Result(row=_PROJECT_ROW)
        if "FROM project_targets" in sql:
            return _Result(rows=self._targets)
        if "FROM connections" in sql:
            return _Result(row=self._connections[(params or {})["cid"]])
        raise AssertionError(f"unexpected query: {sql}")


def _project(tmp_path):
    (tmp_path / "dbt_project.yml").write_text("name: 'proj'\nprofile: 'proj'\n")
    return tmp_path


class MultiTargetProfileTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.dir = Path(__file__).parent / "_tmp_multi_target"
        self.dir.mkdir(exist_ok=True)
        _project(self.dir)

    async def asyncTearDown(self):
        for item in self.dir.iterdir():
            item.unlink()
        self.dir.rmdir()

    async def _render(self, targets):
        session = _Session(
            targets=targets,
            connections={
                "11111111-1111-1111-1111-111111111111": _connection("dev-db", "devwh"),
                "22222222-2222-2222-2222-222222222222": _connection(
                    "prod-db", "prodwh"
                ),
            },
        )
        with patch(
            "app.services.dbt_service.decrypt_secret_or_plaintext",
            side_effect=lambda value: value,
        ):
            env = await DbtService._regenerate_profiles_from_db(
                session, "pid", self.dir
            )
        profile = yaml.safe_load((self.dir / "profiles.yml").read_text())["proj"]
        return profile, env

    async def test_single_connection_still_renders_only_dev(self):
        profile, env = await self._render(targets=[])
        self.assertEqual(list(profile["outputs"]), [DEFAULT_TARGET_NAME])
        self.assertEqual(profile["target"], DEFAULT_TARGET_NAME)
        self.assertEqual(env[DBT_PROFILE_SECRET_ENV], "secret-for-devwh")

    async def test_extra_target_becomes_a_second_output(self):
        profile, env = await self._render(
            targets=[
                {"name": "prod", "connection_id": "22222222-2222-2222-2222-222222222222"}
            ]
        )
        self.assertEqual(sorted(profile["outputs"]), ["dev", "prod"])
        # The default stays the default: adding prod must not silently redirect
        # every existing run to it.
        self.assertEqual(profile["target"], DEFAULT_TARGET_NAME)
        self.assertEqual(profile["outputs"]["dev"]["dbname"], "devwh")
        self.assertEqual(profile["outputs"]["prod"]["dbname"], "prodwh")

    async def test_each_target_gets_its_own_credential_env_var(self):
        profile, env = await self._render(
            targets=[
                {"name": "prod", "connection_id": "22222222-2222-2222-2222-222222222222"}
            ]
        )
        prod_env = f"{DBT_PROFILE_SECRET_ENV}__PROD"
        self.assertEqual(env[DBT_PROFILE_SECRET_ENV], "secret-for-devwh")
        self.assertEqual(env[prod_env], "secret-for-prodwh")
        self.assertIn(DBT_PROFILE_SECRET_ENV, profile["outputs"]["dev"]["password"])
        self.assertIn(prod_env, profile["outputs"]["prod"]["password"])
        # No plaintext password reaches the file, for either target.
        written = (self.dir / "profiles.yml").read_text()
        self.assertNotIn("secret-for-devwh", written)
        self.assertNotIn("secret-for-prodwh", written)

    async def test_a_target_named_dev_does_not_duplicate_the_default(self):
        profile, _ = await self._render(
            targets=[
                {"name": "dev", "connection_id": "22222222-2222-2222-2222-222222222222"}
            ]
        )
        self.assertEqual(list(profile["outputs"]), [DEFAULT_TARGET_NAME])
        self.assertEqual(profile["outputs"]["dev"]["dbname"], "devwh")

    async def test_target_names_that_are_not_identifiers_are_dropped(self):
        # The name reaches profiles.yml, the dbt CLI and an env var suffix.
        profile, env = await self._render(
            targets=[
                {"name": "prod; drop table", "connection_id": "2" * 8},
                {"name": "UPPER", "connection_id": "2" * 8},
            ]
        )
        self.assertEqual(list(profile["outputs"]), [DEFAULT_TARGET_NAME])


class TargetSecretEnvTest(unittest.TestCase):
    def test_default_target_keeps_the_original_env_var_name(self):
        self.assertEqual(
            DbtService.target_secret_env(DEFAULT_TARGET_NAME), DBT_PROFILE_SECRET_ENV
        )

    def test_other_targets_are_suffixed_and_uppercased(self):
        self.assertEqual(
            DbtService.target_secret_env("prod"), f"{DBT_PROFILE_SECRET_ENV}__PROD"
        )
        self.assertEqual(
            DbtService.target_secret_env("pre_prod"),
            f"{DBT_PROFILE_SECRET_ENV}__PRE_PROD",
        )

    def test_suffix_is_always_a_valid_env_var_name(self):
        name = DbtService.target_secret_env("a1_b2")
        self.assertTrue(all(char.isalnum() or char == "_" for char in name))


if __name__ == "__main__":
    unittest.main()
