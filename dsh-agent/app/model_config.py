"""The caller's own model providers, in the harness's own shape.

dbt-craft stores provider routes the way `llm-pi-ai` takes them - a dict keyed by
route, each naming a credential *reference* - and keeps the secrets in a separate
table. The frontend proxy forwards both per request: the dict as
`X-Model-Providers`, the secrets as `X-Model-Credentials`, base64-encoded because
they are JSON documents.

They arrive per request but apply per process: the adapter reads its profiles
from configuration and its credentials from the environment, both fixed when the
harness starts. So a change to either restarts the session, which is what
`fingerprint` is for.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# A credential reference is an environment variable name; a route is a settings
# key. Both reach a file the harness parses, so neither is taken on trust.
_MAX_HEADER_BYTES = 64 * 1024


def _decode(header: str | None) -> dict:
    if not header:
        return {}
    if len(header) > _MAX_HEADER_BYTES:
        logger.warning("model configuration header too large; ignoring it")
        return {}
    try:
        decoded = json.loads(base64.b64decode(header, validate=True))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        logger.warning("model configuration header was not base64 JSON; ignoring it")
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _valid_reference(name: str) -> bool:
    return bool(name) and name.replace("_", "").isalnum() and name[0].isalpha() and name.isupper()


def _valid_route(route: str) -> bool:
    return bool(route) and all(char.isalnum() or char == "-" for char in route) and route[0].isalnum()


@dataclass(frozen=True)
class ModelConfig:
    """One caller's provider routes, their secrets, and the route to start on."""

    providers: dict = field(default_factory=dict)
    credentials: dict = field(default_factory=dict)
    route: str | None = None
    model: str | None = None

    @classmethod
    def from_headers(
        cls,
        providers: str | None,
        credentials: str | None,
        route: str | None,
        model: str | None,
    ) -> "ModelConfig":
        raw_providers = {
            key: value for key, value in _decode(providers).items()
            if _valid_route(str(key)) and isinstance(value, dict)
        }
        raw_credentials = {
            key: str(value) for key, value in _decode(credentials).items()
            if _valid_reference(str(key)) and isinstance(value, (str, int)) and str(value).strip()
        }
        chosen = route if route and _valid_route(route) else None
        return cls(
            providers=raw_providers,
            credentials=raw_credentials,
            route=chosen,
            model=(model or None) if chosen else None,
        )

    @property
    def fingerprint(self) -> str:
        """What must match for a live session to keep serving.

        Hashed rather than stored: this is compared on every prompt and the
        credentials are in it.
        """
        payload = json.dumps(
            {
                "providers": self.providers,
                "credentials": sorted(self.credentials),
                "secrets": hashlib.sha256(
                    json.dumps(self.credentials, sort_keys=True).encode()
                ).hexdigest(),
                "route": self.route,
                "model": self.model,
            },
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode()).hexdigest()

    def overlay(self) -> list | None:
        """A Cordis patch layer configuring the harness's generic adapter.

        `llm-pi-ai` is already in the base composition, so this patches its
        config rather than inserting a row - and a patch replaces a row's whole
        config, which is correct here because that row carries none.
        """
        if not self.providers:
            return None
        return [{"id": "llm-pi-ai", "config": {"providers": self.providers}}]
