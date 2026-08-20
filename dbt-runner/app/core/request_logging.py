"""
Request-logging middleware.

One access line per request — the blanket coverage layer that makes every router
(including the silent ones) observable without per-handler logging. Also binds the
request_id + project_id contextvars so all logs in the request scope correlate.
See /docs/observability-prod-hardening-plan.md Phase 1.
"""

import logging
import re
import time
import uuid
from typing import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.request_context import bind_project_id, bind_request_id

logger = logging.getLogger("app.access")

REQUEST_ID_HEADER = "X-Request-ID"

# ponytail: blanket project_id extraction by UUID-shaped path segment, zero
# per-handler edits. Takes the first UUID in the path. Upgrade to per-route
# path_params binding only if a route ever carries two unrelated UUIDs.
_UUID_RE = re.compile(
    r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.IGNORECASE
)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request_id = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())
        bind_request_id(request_id)
        request.state.request_id = request_id

        m = _UUID_RE.search(request.url.path)
        project_id = m.group(1) if m else None
        if project_id:
            bind_project_id(project_id)

        start = time.monotonic()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers[REQUEST_ID_HEADER] = request_id  # so the frontend can report it
            return response
        finally:
            duration_ms = round((time.monotonic() - start) * 1000, 1)
            logger.info(
                "%s %s %s",
                request.method,
                request.url.path,
                status,
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status": status,
                    "duration_ms": duration_ms,
                    # user_id (the OIDC sub) is set on request.state by require_user;
                    # contextvar mutation inside the endpoint doesn't flow back to the
                    # middleware, so read state directly here.
                    "user_id": getattr(request.state, "user_id", None),
                    "request_id": request_id,
                    "project_id": project_id,
                },
            )
