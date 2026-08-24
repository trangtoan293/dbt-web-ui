"""Authorization by delegation.

This service never reads the application database. It asks dbt-runner, with the
caller's own bearer, for something project-scoped: a 200 means that token owns
that project. Reimplementing OIDC verification, `resolve_user_id` and
`verify_project_ownership` here would be a second copy of rules that must not
drift, and dbt-runner is where every agent action lands anyway.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import HTTPException

from app.config import settings

logger = logging.getLogger(__name__)


async def authorize_project(project_id: str, authorization: str | None) -> None:
    """Raise unless the caller may act on this project."""
    headers = {"Authorization": authorization} if authorization else {}
    url = f"{settings.dbt_runner_url}/files/{project_id}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url, headers=headers)
    except httpx.HTTPError as exc:
        logger.warning("authorization probe failed: %s", exc)
        raise HTTPException(status_code=503, detail="dbt-runner is unreachable") from exc

    if response.status_code == 200:
        return
    if response.status_code in (401, 403, 404):
        # Pass dbt-runner's own answer through: it deliberately returns 404 for
        # another user's project so a 403 cannot confirm the project exists.
        raise HTTPException(status_code=response.status_code, detail="Project not found")
    raise HTTPException(
        status_code=502,
        detail=f"unexpected authorization response {response.status_code}",
    )
