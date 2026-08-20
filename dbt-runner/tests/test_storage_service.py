import os
import sys
import tempfile
import unittest
import importlib.util
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("STORAGE_DIR", "/tmp/dbt-craft-test-storage")

storage_service_path = (
    Path(__file__).resolve().parents[1] / "app" / "services" / "storage_service.py"
)
spec = importlib.util.spec_from_file_location(
    "storage_service_under_test", storage_service_path
)
storage_service_module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(storage_service_module)

StorageService = storage_service_module.StorageService
StorageServiceCompat = storage_service_module.StorageServiceCompat


class StorageServiceCompatTests(unittest.IsolatedAsyncioTestCase):
    async def test_hard_delete_removes_project_storage(self):
        with tempfile.TemporaryDirectory() as tmp:
            inner = StorageService(tmp)
            compat = StorageServiceCompat()
            compat._inner = inner

            inner.upload("project-1", "models/orders.sql", b"select 1")

            deleted = await compat.delete_from_storage("project-1")

            self.assertTrue(deleted)
            self.assertFalse((Path(tmp) / "dbt-projects" / "project-1").exists())

    async def test_soft_delete_and_restore_update_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            inner = StorageService(tmp)
            compat = StorageServiceCompat()
            compat._inner = inner

            marked = await compat.mark_deleted("project-1")
            marker = Path(tmp) / "dbt-projects" / "project-1" / ".deleted.json"

            self.assertTrue(marked)
            self.assertTrue(marker.exists())

            restored = await compat.restore_project("project-1")

            self.assertTrue(restored)
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
