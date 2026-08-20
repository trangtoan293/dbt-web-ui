import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("STORAGE_DIR", "/tmp/dbt-craft-test-storage")

from app.services.file_service import FileService


class _ProjectService:
    def __init__(self, project_path: Path):
        self.project_path = project_path

    def get_path_or_raise(self, project_id: str) -> Path:
        return self.project_path

    def validate_subpath(self, project_path: Path, path: str) -> Path:
        return project_path / path


class FileServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_can_read_logs_extension_and_dbtignore(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_path = Path(tmpdir)
            (project_path / "run.logs").write_text("dbt log output\n")
            (project_path / ".dbtignore").write_text("target/\n")

            service = FileService(project_service=_ProjectService(project_path))

            logs = await service.read_file("project-id", "run.logs")
            dbtignore = await service.read_file("project-id", ".dbtignore")

            self.assertEqual(logs["content"], "dbt log output\n")
            self.assertEqual(dbtignore["content"], "target/\n")

