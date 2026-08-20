import asyncio
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("STORAGE_DIR", "/tmp/dbt-craft-test-storage")

from app.core.file_lock import AsyncFileLock


class _FakeRedis:
    def __init__(self):
        self.values = {}
        self.expires_at = {}
        self.expire_calls = 0

    def _expire_stale(self, key):
        expires_at = self.expires_at.get(key)
        if expires_at is not None and expires_at <= time.monotonic():
            self.values.pop(key, None)
            self.expires_at.pop(key, None)

    async def set(self, key, value, *, nx=False, ex=None):
        self._expire_stale(key)
        if nx and key in self.values:
            return False
        self.values[key] = value
        if ex is not None:
            self.expires_at[key] = time.monotonic() + ex
        return True

    async def exists(self, key):
        self._expire_stale(key)
        return 1 if key in self.values else 0

    async def delete(self, key):
        existed = key in self.values
        self.values.pop(key, None)
        self.expires_at.pop(key, None)
        return 1 if existed else 0

    async def eval(self, script, numkeys, key, token, *args):
        self._expire_stale(key)
        if self.values.get(key) != token:
            return 0
        if "expire" in script:
            ttl = int(args[0])
            self.expires_at[key] = time.monotonic() + ttl
            self.expire_calls += 1
            return 1
        return await self.delete(key)


class AsyncFileLockTests(unittest.IsolatedAsyncioTestCase):
    async def test_lock_renews_ttl_while_context_is_active(self):
        redis = _FakeRedis()

        with (
            patch("app.core.file_lock.get_redis", return_value=redis),
            patch("app.core.file_lock.settings.file_lock_ttl", 3),
        ):
            async with AsyncFileLock.lock("project-id", "dbt_run", timeout=1):
                await asyncio.sleep(1.2)
                self.assertTrue(await AsyncFileLock.is_locked("project-id", "dbt_run"))

            # Assert inside the patch context: outside it, is_locked() would dial
            # a real Redis and the test would only pass where one happens to run.
            self.assertGreaterEqual(redis.expire_calls, 1)
            self.assertFalse(await AsyncFileLock.is_locked("project-id", "dbt_run"))

    async def test_release_does_not_delete_lock_owned_by_another_holder(self):
        redis = _FakeRedis()

        with (
            patch("app.core.file_lock.get_redis", return_value=redis),
            patch("app.core.file_lock.settings.file_lock_ttl", 3),
        ):
            async with AsyncFileLock.lock("project-id", "dbt_run", timeout=1):
                key = "file_lock:project-id:dbt_run"
                redis.values[key] = "different-owner"

        self.assertEqual(
            redis.values["file_lock:project-id:dbt_run"], "different-owner"
        )
