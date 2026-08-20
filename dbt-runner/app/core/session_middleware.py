"""
Session middleware for extracting and managing session IDs.
"""

import logging
import uuid
from typing import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)


class SessionMiddleware(BaseHTTPMiddleware):
    """
    Middleware to extract session ID from request headers.

    The session ID is used for distributed locking to ensure
    only one session can actively work on a project at a time.
    """

    SESSION_HEADER = "X-Session-ID"

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        # Get session ID from header or generate new one
        session_id = request.headers.get(self.SESSION_HEADER)

        if not session_id:
            session_id = str(uuid.uuid4())
            logger.debug(f"Generated new session ID: {session_id[:8]}...")
        else:
            logger.debug(f"Using provided session ID: {session_id[:8]}...")

        # Attach to request state for use in route handlers
        request.state.session_id = session_id

        # Process request
        response = await call_next(request)

        # Include session ID in response for client tracking
        response.headers[self.SESSION_HEADER] = session_id

        return response


def get_session_id(request: Request) -> str:
    """
    Get session ID from request state.

    Args:
        request: FastAPI request object

    Returns:
        Session ID string
    """
    return getattr(request.state, "session_id", str(uuid.uuid4()))
