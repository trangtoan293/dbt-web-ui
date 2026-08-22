"""Sizing the DuckDB engine, and why an unset limit is not a default.

Each dbt run is its own process with its own DuckDB instance. Unbounded, each
takes ~80% of the memory it can see, so MAX_CONCURRENT_DBT_RUNS of them
over-commit the machine and the kernel kills one mid-run instead of DuckDB
spilling to disk. These tests pin the arithmetic that prevents that.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core import duckdb_resources

GIB = 1024 * 1024 * 1024


class MemoryLimitTests(unittest.TestCase):
    def test_explicit_setting_wins(self):
        with patch.object(duckdb_resources.settings, "duckdb_memory_limit", "24GB"):
            self.assertEqual(duckdb_resources.memory_limit_per_run(), "24GB")

    def test_limit_is_the_container_share_not_the_whole_box(self):
        with (
            patch.object(duckdb_resources.settings, "duckdb_memory_limit", ""),
            patch.object(duckdb_resources.settings, "max_concurrent_dbt_runs", 4),
            patch.object(duckdb_resources, "available_memory_bytes", return_value=64 * GIB),
        ):
            limit = duckdb_resources.memory_limit_per_run()
        # 64 GiB * 0.75 headroom / 4 runs = 12 GiB
        self.assertEqual(limit, f"{12 * 1024}MB")

    def test_four_runs_together_stay_under_the_box(self):
        # The property that matters: concurrency x per-run limit must not exceed
        # what the container is allowed, or the limit buys nothing.
        runs = 4
        total = 64 * GIB
        with (
            patch.object(duckdb_resources.settings, "duckdb_memory_limit", ""),
            patch.object(duckdb_resources.settings, "max_concurrent_dbt_runs", runs),
            patch.object(duckdb_resources, "available_memory_bytes", return_value=total),
        ):
            megabytes = int(duckdb_resources.memory_limit_per_run().removesuffix("MB"))
        self.assertLess(megabytes * runs * 1024 * 1024, total)

    def test_tiny_box_is_left_to_duckdb(self):
        # A 200MB share would refuse trivial queries; no limit is better.
        with (
            patch.object(duckdb_resources.settings, "duckdb_memory_limit", ""),
            patch.object(duckdb_resources.settings, "max_concurrent_dbt_runs", 3),
            patch.object(duckdb_resources, "available_memory_bytes", return_value=512 * 1024 * 1024),
        ):
            self.assertIsNone(duckdb_resources.memory_limit_per_run())

    def test_cgroup_limit_beats_host_ram(self):
        # Inside a container with mem_limit, the host's RAM is memory the kernel
        # will not hand out - sizing against it defeats the point.
        with (
            patch.object(duckdb_resources, "_host_memory_bytes", return_value=256 * GIB),
            patch.object(duckdb_resources, "_cgroup_memory_bytes", return_value=8 * GIB),
        ):
            self.assertEqual(duckdb_resources.available_memory_bytes(), 8 * GIB)

    def test_unlimited_cgroup_falls_back_to_host(self):
        with (
            patch.object(duckdb_resources, "_host_memory_bytes", return_value=256 * GIB),
            patch.object(duckdb_resources, "_cgroup_memory_bytes", return_value=None),
        ):
            self.assertEqual(duckdb_resources.available_memory_bytes(), 256 * GIB)


class SpillDirectoryTests(unittest.TestCase):
    def test_spill_is_per_project_under_storage(self):
        with (
            patch.object(duckdb_resources.settings, "duckdb_temp_dir", ""),
            patch.object(duckdb_resources.settings, "storage_dir", "/data/storage"),
        ):
            path = duckdb_resources.temp_directory("proj-1")
        self.assertEqual(path, "/data/storage/duckdb-tmp/proj-1")

    def test_directory_is_created_because_duckdb_will_not(self):
        # DuckDB does not create a missing temp_directory; it fails the first
        # query that needs to spill, which is the largest one, hours in.
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.object(duckdb_resources.settings, "duckdb_temp_dir", f"{tmp}/spill"),
                patch.object(duckdb_resources.settings, "duckdb_memory_limit", "8GB"),
                patch.object(duckdb_resources.settings, "duckdb_threads", 0),
                patch.object(duckdb_resources.settings, "duckdb_max_temp_size", ""),
                patch.object(duckdb_resources.settings, "duckdb_preserve_insertion_order", ""),
            ):
                values = duckdb_resources.profile_settings("p")
            self.assertTrue(Path(values["temp_directory"]).is_dir())


class ProfileSettingsTests(unittest.TestCase):
    def _settings(self, **overrides):
        defaults = {
            "duckdb_memory_limit": "8GB",
            "duckdb_threads": 0,
            "duckdb_temp_dir": "",
            "duckdb_max_temp_size": "",
            "duckdb_preserve_insertion_order": "",
            "storage_dir": "/tmp/does-not-matter",
        }
        defaults.update(overrides)
        return [patch.object(duckdb_resources.settings, k, v) for k, v in defaults.items()]

    def test_unset_knobs_are_omitted_not_passed_as_none(self):
        for patcher in self._settings():
            patcher.start()
        self.addCleanup(patch.stopall)
        values = duckdb_resources.profile_settings()
        self.assertNotIn("threads", values)
        self.assertNotIn("max_temp_directory_size", values)
        self.assertNotIn("preserve_insertion_order", values)

    def test_insertion_order_only_appears_when_switched_off(self):
        for patcher in self._settings(duckdb_preserve_insertion_order="false"):
            patcher.start()
        self.addCleanup(patch.stopall)
        self.assertIs(
            duckdb_resources.profile_settings()["preserve_insertion_order"], False
        )


if __name__ == "__main__":
    unittest.main()
