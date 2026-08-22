"""--target reaches the dbt CLI, so its shape is checked, not quoted.

Also covers `dbt source freshness`: two words on the CLI, one enum value in
dbt_runs.command. Get that mapping wrong and every freshness run is recorded as
a plain `run`.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.exceptions import DbtOperationError
from app.models.dbt import DbtCommand
from app.services.dbt_service import TARGET_NAME_RE, DbtService


class TargetNameShapeTest(unittest.TestCase):
    def test_accepts_ordinary_target_names(self):
        for name in ("dev", "prod", "pre_prod", "eu1", "a" * 30):
            self.assertTrue(TARGET_NAME_RE.match(name), name)

    def test_rejects_anything_that_could_be_an_argument_or_shell_token(self):
        for name in (
            "",
            "Prod",
            "1st",
            "prod prod",
            "prod;rm -rf /",
            "--profiles-dir",
            "../etc",
            "prod$(id)",
            "a" * 31,
        ):
            self.assertIsNone(TARGET_NAME_RE.match(name), name)


class RunCommandTargetTest(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_target_is_refused_before_dbt_is_invoked(self):
        service = DbtService()
        service.project = MagicMock()
        service.project.get_path_or_raise.return_value = Path("/tmp")
        service._run_dbt_command = AsyncMock()

        with self.assertRaises(DbtOperationError):
            await service.run_command(
                DbtCommand(project_id="p1", command="run", target="Prod; drop")
            )
        service._run_dbt_command.assert_not_awaited()


class RunEnumMappingTest(unittest.IsolatedAsyncioTestCase):
    async def _recorded_command(self, command_name):
        session = MagicMock()
        session.execute = AsyncMock()
        session.commit = AsyncMock()
        with patch("asyncio.create_subprocess_exec", side_effect=OSError("no git")):
            await DbtService._insert_run_start(
                session,
                "00000000-0000-0000-0000-000000000001",
                "00000000-0000-0000-0000-000000000002",
                command_name,
                None,
                __import__("datetime").datetime.now(),
                Path("/tmp"),
            )
        return session.execute.await_args.args[1]["command"]

    async def test_source_maps_to_the_source_freshness_enum_value(self):
        self.assertEqual(await self._recorded_command("source"), "source_freshness")

    async def test_known_commands_are_kept(self):
        self.assertEqual(await self._recorded_command("build"), "build")

    async def test_unknown_commands_fall_back_to_run(self):
        self.assertEqual(await self._recorded_command("nonsense"), "run")


if __name__ == "__main__":
    unittest.main()
