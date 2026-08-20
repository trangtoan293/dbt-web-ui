"""
Browser error ingest.

The frontend ships uncaught errors (ErrorBoundary + window.onerror) here; the line
is logged as JSON to stdout and picked up by the k8s collector into OpenObserve,
correlated by request_id. Untrusted input → body size cap + per-IP rate limit.
"""

import logging
import time

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from app.config import settings
from app.core.request_context import bind_request_id

logger = logging.getLogger("app.client")

router = APIRouter(tags=["Observability"])

# ponytail: per-process fixed-window rate limit (30 req / 10s / IP). In-memory, so
# the cap is per replica, not global — fine for abuse control. Move to Redis only
# if a single client must be throttled across replicas.
_WINDOW_SECONDS = 10
_MAX_PER_WINDOW = 30
_hits: dict[str, tuple[int, float]] = {}


def _rate_limited(ip: str) -> bool:
    count, window_start = _hits.get(ip, (0, time.monotonic()))
    now = time.monotonic()
    if now - window_start >= _WINDOW_SECONDS:
        _hits[ip] = (1, now)
        return False
    if count >= _MAX_PER_WINDOW:
        return True
    _hits[ip] = (count + 1, window_start)
    return False


class ClientError(BaseModel):
    message: str = Field(max_length=2000)
    stack: str | None = Field(default=None, max_length=8000)
    url: str | None = Field(default=None, max_length=2000)
    request_id: str | None = Field(default=None, max_length=64)
    level: str = Field(default="error", max_length=16)


@router.post("/client-logs", status_code=204)
async def ingest_client_log(payload: ClientError, request: Request) -> Response:
    ip = request.client.host if request.client else "unknown"
    if _rate_limited(ip):
        return Response(status_code=429)

    # Body size guard (defence-in-depth beyond field max_lengths).
    body_len = int(request.headers.get("content-length") or 0)
    if body_len > settings.client_logs_max_bytes:
        return Response(status_code=413)

    if payload.request_id:
        bind_request_id(payload.request_id)

    logger.warning(
        "client error: %s",
        payload.message,
        extra={
            "source": "browser",
            "client_url": payload.url,
            "client_stack": payload.stack,
            "client_level": payload.level,
        },
    )
    return Response(status_code=204)
