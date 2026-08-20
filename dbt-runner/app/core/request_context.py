"""
Request-scoped correlation context.

Holds the correlation axis (request_id + user_id + project_id) in contextvars so
every log line in a request's scope carries them automatically — no threading
ids through call signatures. See /CONTEXT.md "Correlation axis".
"""

from contextvars import ContextVar

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("user_id", default=None)
project_id_var: ContextVar[str | None] = ContextVar("project_id", default=None)


def bind_request_id(value: str | None) -> None:
    request_id_var.set(value)


def bind_user_id(value: str | None) -> None:
    user_id_var.set(value)


def bind_project_id(value: str | None) -> None:
    project_id_var.set(value)


def correlation_headers() -> dict[str, str]:
    """Headers to forward request_id to a downstream service."""
    rid = request_id_var.get()
    return {"X-Request-ID": rid} if rid else {}


def current_context() -> dict[str, str]:
    """Non-null correlation fields, for attaching to logs or outbound headers."""
    out: dict[str, str] = {}
    for key, var in (
        ("request_id", request_id_var),
        ("user_id", user_id_var),
        ("project_id", project_id_var),
    ):
        val = var.get()
        if val:
            out[key] = val
    return out
