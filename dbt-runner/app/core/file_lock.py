"""
Async file locking for protecting file system operations.
Uses Redis for cross-worker synchronization.
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Optional
from uuid import uuid4

from app.config import settings
from app.core.redis_client import get_redis

logger = logging.getLogger(__name__)


class AsyncFileLock:
    """
    Distributed file lock for protecting file operations.

    Uses Redis for cross-worker synchronization to prevent
    race conditions on file system operations like:
    - Writing to manifest.json
    - Modifying target/ directory
    - Concurrent dbt runs
    """

    LOCK_PREFIX = "file_lock"
    _RENEW_SCRIPT = """
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("expire", KEYS[1], ARGV[2])
        end
        return 0
    """
    _RELEASE_SCRIPT = """
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        end
        return 0
    """

    @classmethod
    @asynccontextmanager
    async def lock(
        cls, project_id: str, resource: str = "default", timeout: Optional[int] = None
    ):
        """
        Acquire file lock for a resource within a project.

        Args:
            project_id: The project identifier
            resource: Resource name (e.g., "dbt_run", "compile", "target")
            timeout: Max seconds to wait for lock (default: from settings)

        Usage:
            async with AsyncFileLock.lock(project_id, "dbt_run"):
                await run_dbt_command(...)

        Raises:
            TimeoutError: If lock cannot be acquired within timeout
        """
        timeout = timeout or settings.file_lock_wait_timeout
        lock_key = f"{cls.LOCK_PREFIX}:{project_id}:{resource}"
        lock_token = str(uuid4())
        renew_interval = max(1, min(settings.file_lock_ttl // 3, 20))

        redis = await get_redis()
        acquired = False
        wait_time = 0
        retry_delay = 1  # seconds
        renew_task: Optional[asyncio.Task] = None

        async def renew_lock() -> None:
            while True:
                await asyncio.sleep(renew_interval)
                try:
                    renewed = await redis.eval(
                        cls._RENEW_SCRIPT,
                        1,
                        lock_key,
                        lock_token,
                        settings.file_lock_ttl,
                    )
                except Exception as e:
                    logger.error("Failed to renew lock %s: %s", lock_key, e)
                    return
                if renewed != 1:
                    logger.warning(
                        "Lost lock ownership before release: %s", lock_key
                    )
                    return

        logger.debug(f"Attempting to acquire lock: {lock_key}")

        while wait_time < timeout:
            # Try to acquire lock using SET NX (only if not exists)
            acquired = await redis.set(
                lock_key, lock_token, nx=True, ex=settings.file_lock_ttl
            )

            if acquired:
                logger.debug(f"Acquired lock: {lock_key}")
                break

            # Wait and retry
            await asyncio.sleep(retry_delay)
            wait_time += retry_delay

            if wait_time % 10 == 0:
                logger.info(f"Waiting for lock {lock_key} ({wait_time}s elapsed)")

        if not acquired:
            logger.error(f"Failed to acquire lock {lock_key} after {timeout}s")
            raise TimeoutError(
                f"Could not acquire lock for {resource} in project {project_id} "
                f"after {timeout}s. Another operation may be in progress."
            )

        try:
            renew_task = asyncio.create_task(renew_lock())
            yield
        except Exception as e:
            # Log the exception but still release the lock
            logger.warning(f"Exception during locked operation {lock_key}: {e}")
            raise
        finally:
            if renew_task:
                renew_task.cancel()
                try:
                    await renew_task
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    logger.error("Lock renewal task failed for %s: %s", lock_key, e)
            # Always release lock, even on error
            try:
                released = await redis.eval(
                    cls._RELEASE_SCRIPT, 1, lock_key, lock_token
                )
                if released == 1:
                    logger.debug(f"Released lock: {lock_key}")
                else:
                    logger.warning(
                        "Skipped releasing lock no longer owned by this holder: %s",
                        lock_key,
                    )
            except Exception as e:
                logger.error(f"Failed to release lock {lock_key}: {e}")

    @classmethod
    async def is_locked(cls, project_id: str, resource: str = "default") -> bool:
        """
        Check if a resource is currently locked.

        Args:
            project_id: The project identifier
            resource: Resource name

        Returns:
            True if locked, False otherwise
        """
        redis = await get_redis()
        lock_key = f"{cls.LOCK_PREFIX}:{project_id}:{resource}"

        exists = await redis.exists(lock_key)
        return exists > 0

    @classmethod
    async def force_release(cls, project_id: str, resource: str = "default") -> bool:
        """
        Force release a lock (admin use only).

        Args:
            project_id: The project identifier
            resource: Resource name

        Returns:
            True if lock existed and was released
        """
        redis = await get_redis()
        lock_key = f"{cls.LOCK_PREFIX}:{project_id}:{resource}"

        result = await redis.delete(lock_key)

        if result > 0:
            logger.warning(f"Force released lock: {lock_key}")

        return result > 0
