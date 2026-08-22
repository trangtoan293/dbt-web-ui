"""Outbound failure notifications for scheduled runs.

A webhook URL is typed in by a user and fetched by the server, which is the
same SSRF hole as a connection host - so it goes through host_guard exactly
like one. Without that check a schedule pointed at http://<app-postgres> or at
169.254.169.254 turns the notifier into a probe for internal services.

One payload shape serves every common receiver: Slack and Teams read `text`,
Discord reads `content`, and a custom endpoint gets the structured `run` object.
Cheaper than a per-provider adapter nobody asked for.
"""

import asyncio
import logging
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx

from app.config import settings
from app.core.host_guard import HostNotAllowed, assert_host_allowed

logger = logging.getLogger(__name__)

_ALLOWED_SCHEMES = ("http", "https")


class WebhookRejected(ValueError):
    """Raised when a webhook URL is unusable or refused by policy."""


async def assert_webhook_allowed(url: str) -> None:
    """Validate a webhook URL's scheme and target. Raises WebhookRejected."""
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in _ALLOWED_SCHEMES:
        raise WebhookRejected("Webhook URL must be http:// or https://")
    if not parsed.hostname:
        raise WebhookRejected("Webhook URL has no host")
    try:
        port = parsed.port
    except ValueError:
        raise WebhookRejected("Webhook URL has an invalid port") from None
    try:
        # Resolution blocks, so keep it off the event loop.
        await asyncio.to_thread(assert_host_allowed, parsed.hostname, port)
    except HostNotAllowed as exc:
        raise WebhookRejected(str(exc)) from exc


def _summary_line(run: Dict[str, Any], schedule_name: str) -> str:
    project = run.get("project_name") or run.get("project_id") or "project"
    status = run.get("status") or "unknown"
    detail = run.get("error_message") or ""
    models = (
        f" {run.get('models_error') or 0} of {run.get('models_total') or 0} models failed."
        if run.get("models_total")
        else ""
    )
    line = (
        f"dbt schedule '{schedule_name}' on {project}: "
        f"{run.get('command') or 'run'} {status}.{models}"
    )
    return f"{line} {detail}".strip()


def build_payload(run: Dict[str, Any], schedule_name: str) -> Dict[str, Any]:
    """The JSON body posted to a webhook."""
    text = _summary_line(run, schedule_name)
    return {
        "text": text,  # Slack, Mattermost, Teams
        "content": text,  # Discord
        "schedule": schedule_name,
        "run": {
            "id": run.get("id"),
            "project_id": run.get("project_id"),
            "project_name": run.get("project_name"),
            "command": run.get("command"),
            "selector": run.get("selector"),
            "status": run.get("status"),
            "duration_ms": run.get("duration_ms"),
            "models_total": run.get("models_total"),
            "models_error": run.get("models_error"),
            "error_message": run.get("error_message"),
        },
    }


async def post_run_notification(
    url: str,
    run: Dict[str, Any],
    schedule_name: str,
    *,
    client: Optional[httpx.AsyncClient] = None,
) -> bool:
    """Deliver one notification. Returns whether the receiver accepted it.

    Never raises: a schedule whose webhook is broken must still keep running its
    dbt command. ponytail: no retry queue - one attempt, logged on failure.
    Add one when someone actually needs guaranteed delivery.
    """
    try:
        await assert_webhook_allowed(url)
    except WebhookRejected as exc:
        logger.warning("Webhook for schedule '%s' refused: %s", schedule_name, exc)
        return False

    payload = build_payload(run, schedule_name)
    timeout = settings.webhook_timeout_seconds
    try:
        if client is not None:
            response = await client.post(url, json=payload, timeout=timeout)
        else:
            async with httpx.AsyncClient(timeout=timeout) as owned:
                response = await owned.post(url, json=payload)
        if response.status_code >= 400:
            logger.warning(
                "Webhook for schedule '%s' returned HTTP %s",
                schedule_name,
                response.status_code,
            )
            return False
        return True
    except Exception as exc:
        logger.warning("Webhook for schedule '%s' failed: %s", schedule_name, exc)
        return False
