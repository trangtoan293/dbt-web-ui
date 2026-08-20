"""
Redis client singleton for distributed locking.
"""

import logging
from typing import Optional

import redis.asyncio as redis

from app.config import settings

logger = logging.getLogger(__name__)

_redis_client: Optional[redis.Redis] = None


async def get_redis() -> redis.Redis:
    """Get or create Redis client singleton."""
    global _redis_client

    if _redis_client is None:
        logger.info(f"Connecting to Redis at {settings.redis_url}")
        _redis_client = redis.from_url(
            settings.redis_url, encoding="utf-8", decode_responses=True
        )
        # Test connection
        try:
            await _redis_client.ping()  # type: ignore[misc]
            logger.info("Redis connection established")
        except redis.ConnectionError as e:
            logger.error(f"Failed to connect to Redis: {e}")
            raise

    return _redis_client


async def close_redis():
    """Close Redis connection."""
    global _redis_client

    if _redis_client:
        logger.info("Closing Redis connection")
        await _redis_client.close()
        _redis_client = None


async def check_redis_health() -> bool:
    """Check if Redis is available."""
    try:
        client = await get_redis()
        await client.ping()  # type: ignore[misc]
        return True
    except Exception as e:
        logger.error(f"Redis health check failed: {e}")
        return False
