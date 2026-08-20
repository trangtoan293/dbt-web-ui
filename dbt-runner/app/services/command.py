"""
Command execution service.
Handles running shell commands with support for cancellation.
Uses Redis for cross-worker process tracking.
"""

import asyncio
import logging
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from app.config import settings
from app.core.redis_client import get_redis

logger = logging.getLogger(__name__)


class CommandService:
    """
    Service for executing shell commands.

    Uses Redis for process tracking to enable cross-worker cancellation.
    Local process references are kept in instance variable for actual termination.
    """

    # Redis key prefix for process tracking
    PROCESS_KEY_PREFIX = "running_process"

    # Local process references (per-worker, for actual termination)
    _local_processes: Dict[str, asyncio.subprocess.Process] = {}

    @classmethod
    async def _register_process(cls, process_id: str) -> None:
        """Register running process in Redis with worker ID."""
        try:
            redis = await get_redis()
            if redis:
                worker_id = f"{os.getpid()}"
                await redis.set(
                    f"{cls.PROCESS_KEY_PREFIX}:{process_id}",
                    worker_id,
                    ex=300,  # 5 min TTL as safety net
                )
        except Exception as e:
            logger.warning(f"Failed to register process in Redis: {e}")

    @classmethod
    async def _unregister_process(cls, process_id: str) -> None:
        """Unregister process from Redis."""
        try:
            redis = await get_redis()
            if redis:
                await redis.delete(f"{cls.PROCESS_KEY_PREFIX}:{process_id}")
        except Exception as e:
            logger.warning(f"Failed to unregister process from Redis: {e}")

    @classmethod
    async def _mark_cancelled(cls, process_id: str) -> None:
        """Mark process as cancelled in Redis (for cross-worker signaling)."""
        try:
            redis = await get_redis()
            if redis:
                await redis.set(
                    f"{cls.PROCESS_KEY_PREFIX}:{process_id}:cancelled",
                    "1",
                    ex=60,  # Short TTL for cancel signal
                )
        except Exception as e:
            logger.warning(f"Failed to mark process cancelled: {e}")

    @classmethod
    async def _is_cancelled(cls, process_id: str) -> bool:
        """Check if process was marked as cancelled."""
        try:
            redis = await get_redis()
            if redis:
                return (
                    await redis.exists(
                        f"{cls.PROCESS_KEY_PREFIX}:{process_id}:cancelled"
                    )
                    > 0
                )
        except Exception:
            pass
        return False

    @classmethod
    async def run(
        cls, cmd: List[str], cwd: Path, env: Optional[Dict[str, str]] = None
    ) -> Tuple[int, str, str]:
        """
        Run a shell command and return result.

        Args:
            cmd: Command as list of strings
            cwd: Working directory

        Returns:
            Tuple of (returncode, stdout, stderr)
        """
        logger.debug(f"Running command: {' '.join(cmd)} in {cwd}")

        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            env={**os.environ, **(env or {})},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()

        return process.returncode or 0, stdout.decode(), stderr.decode()

    @classmethod
    async def run_cancellable(
        cls,
        cmd: List[str],
        cwd: Path,
        process_id: str,
        env: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> Tuple[int, str, str]:
        """
        Run a shell command that can be cancelled.

        Args:
            cmd: Command as list of strings
            cwd: Working directory
            process_id: Unique identifier for the process (usually project_id)

        Returns:
            Tuple of (returncode, stdout, stderr)
        """
        logger.debug(
            f"Running cancellable command: {' '.join(cmd)} with id {process_id}"
        )

        # Never wait forever: a hung dbt holds the project lock until TTL.
        if timeout is None:
            timeout = settings.dbt_subprocess_timeout

        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            env={**os.environ, **(env or {})},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Store in both local dict and Redis
        cls._local_processes[process_id] = process
        await cls._register_process(process_id)

        try:
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=timeout,
                )
            except asyncio.TimeoutError:
                process.terminate()
                try:
                    stdout, stderr = await asyncio.wait_for(
                        process.communicate(),
                        timeout=5,
                    )
                except asyncio.TimeoutError:
                    process.kill()
                    stdout, stderr = await process.communicate()
                return (
                    -1,
                    stdout.decode(),
                    stderr.decode()
                    or f"Command timed out after {timeout:g} seconds",
                )

            # Check if cancelled by another worker
            if await cls._is_cancelled(process_id):
                return -1, "", "Command cancelled by user"

            return process.returncode or 0, stdout.decode(), stderr.decode()
        except asyncio.CancelledError:
            process.terminate()
            await process.wait()
            return -1, "", "Command cancelled by user"
        finally:
            # Remove from tracking
            cls._local_processes.pop(process_id, None)
            await cls._unregister_process(process_id)

    @classmethod
    async def cancel(cls, process_id: str) -> bool:
        """
        Cancel a running process.

        Works across workers by:
        1. Marking cancelled in Redis (for cross-worker notification)
        2. Terminating local process if running on this worker

        Args:
            process_id: Process identifier

        Returns:
            True if cancellation was signaled
        """
        # Always mark as cancelled in Redis (works across workers)
        await cls._mark_cancelled(process_id)

        # Try to terminate local process if it exists on this worker
        process = cls._local_processes.get(process_id)
        if process:
            try:
                process.terminate()
                await asyncio.sleep(0.5)
                if process.returncode is None:
                    process.kill()
                cls._local_processes.pop(process_id, None)
                logger.info(f"Process {process_id} terminated locally")
            except Exception as e:
                logger.error(f"Error terminating process {process_id}: {e}")

        # Unregister from Redis
        await cls._unregister_process(process_id)
        logger.info(f"Process {process_id} cancelled")
        return True

    @classmethod
    async def is_running(cls, process_id: str) -> bool:
        """
        Check if a process is running (in any worker).

        Args:
            process_id: Process identifier

        Returns:
            True if process is running
        """
        try:
            redis = await get_redis()
            if redis:
                return await redis.exists(f"{cls.PROCESS_KEY_PREFIX}:{process_id}") > 0
        except Exception:
            pass
        # Fallback to local check
        process = cls._local_processes.get(process_id)
        return process is not None and process.returncode is None
