"""
Session locking service for distributed session management.
Prevents concurrent access from multiple sessions to the same project.
"""

import logging
from typing import Any, Dict, Optional

from fastapi import HTTPException

from app.config import settings
from app.core.redis_client import get_redis

logger = logging.getLogger(__name__)


class SessionLockService:
    """
    Distributed session lock using Redis.

    Ensures only one session can actively work on a project at a time.
    This prevents conflicts when the same user accesses from multiple devices.
    """

    LOCK_PREFIX = "project_lock"

    @classmethod
    async def acquire_project_lock(
        cls, project_id: str, session_id: str, force: bool = False
    ) -> Dict[str, Any]:
        """
        Acquire lock for a project.

        Args:
            project_id: The project identifier
            session_id: The session requesting the lock
            force: If True, forcibly take over the lock

        Returns:
            Dict with lock status information

        Raises:
            HTTPException: 423 if project is locked by another session
        """
        redis = await get_redis()
        lock_key = f"{cls.LOCK_PREFIX}:{project_id}"

        # Check existing lock
        current = await redis.get(lock_key)

        if current and current != session_id and not force:
            logger.warning(
                f"Project {project_id} locked by session {current}, "
                f"rejecting session {session_id}"
            )
            raise HTTPException(
                status_code=423,
                detail={
                    "error": "project_locked",
                    "message": "Another session is active for this project. "
                    "Close other sessions or force takeover.",
                    "locked_by_session": current[:8] + "...",  # Partial for privacy
                    "project_id": project_id,
                },
            )

        # Set/refresh lock
        await redis.set(lock_key, session_id, ex=settings.session_lock_ttl)

        logger.info(f"Session {session_id[:8]} acquired lock for project {project_id}")

        return {
            "acquired": True,
            "project_id": project_id,
            "session_id": session_id,
            "ttl_seconds": settings.session_lock_ttl,
        }

    @classmethod
    async def release_project_lock(cls, project_id: str, session_id: str) -> bool:
        """
        Release lock if owned by this session.

        Args:
            project_id: The project identifier
            session_id: The session releasing the lock

        Returns:
            True if lock was released, False if not owned
        """
        redis = await get_redis()
        lock_key = f"{cls.LOCK_PREFIX}:{project_id}"

        current = await redis.get(lock_key)

        if current == session_id:
            await redis.delete(lock_key)
            logger.info(
                f"Session {session_id[:8]} released lock for project {project_id}"
            )
            return True

        return False

    @classmethod
    async def refresh_lock(cls, project_id: str, session_id: str) -> bool:
        """
        Extend lock TTL if owned by this session.

        Args:
            project_id: The project identifier
            session_id: The session refreshing the lock

        Returns:
            True if lock was refreshed, False if not owned
        """
        redis = await get_redis()
        lock_key = f"{cls.LOCK_PREFIX}:{project_id}"

        current = await redis.get(lock_key)

        if current == session_id:
            await redis.expire(lock_key, settings.session_lock_ttl)
            return True

        return False

    @classmethod
    async def get_lock_status(
        cls, project_id: str, session_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get current lock status for a project.

        Args:
            project_id: The project identifier
            session_id: Optional current session to check ownership

        Returns:
            Dict with lock status information
        """
        redis = await get_redis()
        lock_key = f"{cls.LOCK_PREFIX}:{project_id}"

        current = await redis.get(lock_key)
        ttl = await redis.ttl(lock_key)

        return {
            "project_id": project_id,
            "is_locked": current is not None,
            "is_owned_by_current_session": (
                current == session_id if session_id else None
            ),
            "locked_by_session": current[:8] + "..." if current else None,
            "ttl_seconds": ttl if ttl > 0 else None,
        }

    @classmethod
    async def force_release_lock(cls, project_id: str) -> bool:
        """
        Force release a lock (admin use only).

        Args:
            project_id: The project identifier

        Returns:
            True if lock existed and was released
        """
        redis = await get_redis()
        lock_key = f"{cls.LOCK_PREFIX}:{project_id}"

        result = await redis.delete(lock_key)
        logger.warning(f"Force released lock for project {project_id}")
        return result > 0
