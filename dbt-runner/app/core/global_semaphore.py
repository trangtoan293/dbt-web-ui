"""Global Redis semaphore capping concurrent dbt runs across uvicorn workers."""

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import HTTPException

from app.config import settings
from app.core.redis_client import get_redis

logger = logging.getLogger(__name__)

SEMAPHORE_KEY = "global:dbt_runs"
# Ad-hoc console queries get their own pool rather than a share of the run pool:
# a console has to stay usable while a batch runs, and a batch must not be
# starved by consoles. The two limits are still sized *together* - see
# app/core/duckdb_resources.py, which divides the memory budget by their sum,
# because a slot in either pool is a DuckDB instance that can go active.
QUERY_SEMAPHORE_KEY = "global:dbt_queries"
LEASE_TTL_SECONDS = 120

_ACQUIRE_SCRIPT = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  return 1
end
return 0
"""


async def _try_acquire(
    token: str,
    lease_ttl: int,
    *,
    key: str = SEMAPHORE_KEY,
    limit: int | None = None,
) -> bool:
    redis = await get_redis()
    now = time.time()
    acquired = await redis.eval(
        _ACQUIRE_SCRIPT,
        1,
        key,
        now,
        now + lease_ttl,
        settings.max_concurrent_dbt_runs if limit is None else limit,
        token,
    )
    return bool(acquired)


async def _renew_loop(
    token: str, lease_ttl: int, stop: asyncio.Event, key: str = SEMAPHORE_KEY
) -> None:
    redis = await get_redis()
    interval = max(1, lease_ttl / 3)
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            await redis.zadd(key, {token: time.time() + lease_ttl})


@asynccontextmanager
async def global_run_semaphore(lease_ttl: int = LEASE_TTL_SECONDS):
    """
    Acquire a global slot for a user-triggered dbt run.

    Raises HTTP 429 immediately when capacity is full. The slot is lease-backed,
    so a crashed process stops renewing and Redis expires the slot naturally.
    """
    token = f"http:{uuid.uuid4()}"
    if not await _try_acquire(token, lease_ttl):
        logger.warning(
            f"Global dbt run limit reached ({settings.max_concurrent_dbt_runs}). "
            f"Rejecting new run."
        )
        raise HTTPException(
            status_code=429,
            detail={
                "error": "too_many_concurrent_runs",
                "message": (
                    f"System is at capacity ({settings.max_concurrent_dbt_runs} "
                    "concurrent runs). Try again in a moment."
                ),
                "max_concurrent_runs": settings.max_concurrent_dbt_runs,
            },
        )

    redis = await get_redis()
    stop = asyncio.Event()
    renew_task = asyncio.create_task(_renew_loop(token, lease_ttl, stop))
    logger.debug("Global dbt run slot acquired token=%s", token)
    try:
        yield
    finally:
        stop.set()
        renew_task.cancel()
        await asyncio.gather(renew_task, return_exceptions=True)
        await redis.zrem(SEMAPHORE_KEY, token)
        logger.debug("Global dbt run slot released token=%s", token)


@asynccontextmanager
async def global_run_semaphore_blocking(
    *,
    poll_seconds: float = 2.0,
    max_wait_seconds: float | None = None,
    lease_ttl: int = LEASE_TTL_SECONDS,
):
    """Acquire a global slot for background workers, waiting instead of 429."""
    token = f"run:{uuid.uuid4()}"
    started = time.monotonic()
    while True:
        if await _try_acquire(token, lease_ttl):
            break
        if max_wait_seconds is not None and time.monotonic() - started > max_wait_seconds:
            raise TimeoutError("Timed out waiting for global dbt run slot")
        await asyncio.sleep(poll_seconds)

    redis = await get_redis()
    stop = asyncio.Event()
    renew_task = asyncio.create_task(_renew_loop(token, lease_ttl, stop))
    logger.debug("Global dbt run slot acquired token=%s", token)
    try:
        yield
    finally:
        stop.set()
        renew_task.cancel()
        await asyncio.gather(renew_task, return_exceptions=True)
        await redis.zrem(SEMAPHORE_KEY, token)
        logger.debug("Global dbt run slot released token=%s", token)


@asynccontextmanager
async def global_query_semaphore(lease_ttl: int = LEASE_TTL_SECONDS):
    """Acquire a global slot for one ad-hoc console query.

    Without this, console queries were the one kind of DuckDB work nothing
    capped. Runs and ingest each take a slot from the run pool; an inline query
    took only a per-project lock, so N projects querying at once meant N DuckDB
    instances, each entitled to a full run's memory share, and the per-instance
    limit stopped bounding the machine.

    Raises HTTP 429 when full rather than queueing: a person is waiting on this,
    and "try again" beats a request that hangs until its timeout.
    """
    limit = max(1, settings.max_concurrent_queries)
    token = f"query:{uuid.uuid4()}"
    if not await _try_acquire(token, lease_ttl, key=QUERY_SEMAPHORE_KEY, limit=limit):
        logger.warning("Global query limit reached (%s). Rejecting query.", limit)
        raise HTTPException(
            status_code=429,
            detail={
                "error": "too_many_concurrent_queries",
                "message": (
                    f"System is at capacity ({limit} concurrent queries). "
                    "Try again in a moment."
                ),
                "max_concurrent_queries": limit,
            },
        )

    redis = await get_redis()
    stop = asyncio.Event()
    renew_task = asyncio.create_task(
        _renew_loop(token, lease_ttl, stop, QUERY_SEMAPHORE_KEY)
    )
    try:
        yield
    finally:
        stop.set()
        renew_task.cancel()
        await asyncio.gather(renew_task, return_exceptions=True)
        await redis.zrem(QUERY_SEMAPHORE_KEY, token)
