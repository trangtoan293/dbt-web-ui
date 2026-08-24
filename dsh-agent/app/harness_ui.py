"""Handing the harness's own web UI the same providers and keys.

That UI resolves routes from its `$DSH_HOME/settings.yaml` (`llm-pi-ai:`
section) and credentials from `$DSH_HOME/.credentials.yaml`, both hot-reloaded.
A person who configured a provider in dbt-craft should not configure it again
there - but that UI has no authentication of its own, so those documents are
shared by whoever opens it. Writing one user's configuration into it is therefore
only correct when the deployment has exactly one user (`AUTH_DISABLED=true`);
with OIDC on, this refuses and the operator configures that surface separately.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import yaml

from app.config import settings
from app.model_config import ModelConfig

logger = logging.getLogger(__name__)


def _write_private(path: Path, content: str) -> None:
    if path.is_file() and path.read_text() == content:
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(content)


def provision_credential(model_config: ModelConfig) -> bool:
    """Mirror the caller's providers and keys into the harness UI's own home."""
    if settings.web_home is None or not settings.auth_disabled:
        # Several users, one shared unauthenticated surface: not ours to share.
        return False
    if not model_config.credentials:
        return False

    # The credential document is a plain mapping of reference to value and the
    # harness rejects any deviation, so a value that would rewrite it is refused.
    credentials = {
        name: value for name, value in model_config.credentials.items()
        if "\n" not in value and ":" not in value
    }
    if not credentials:
        return False

    try:
        settings.web_home.mkdir(parents=True, exist_ok=True)
        os.chmod(settings.web_home, 0o700)
        _write_private(
            settings.web_home / ".credentials.yaml",
            "".join(f"{name}: {value}\n" for name, value in sorted(credentials.items())),
        )
        # Settings carry the routes, never a secret - the same split the harness
        # itself keeps. Without this the UI has a key but no route to use it on,
        # and its first-run dialog keeps asking for one.
        #
        # Merged, not replaced: that document belongs to the harness UI as well,
        # and overwriting it would drop whatever that UI stored there itself.
        if model_config.providers:
            path = settings.web_home / "settings.yaml"
            document: dict = {}
            if path.is_file():
                try:
                    loaded = yaml.safe_load(path.read_text())
                    document = loaded if isinstance(loaded, dict) else {}
                except yaml.YAMLError:
                    logger.warning("harness UI settings document is unreadable; replacing it")
            section = document.get("llm-pi-ai")
            document["llm-pi-ai"] = {
                **(section if isinstance(section, dict) else {}),
                "providers": model_config.providers,
            }
            _write_private(path, yaml.safe_dump(document, sort_keys=False))
    except OSError as exc:
        logger.warning("could not hand the harness UI a configuration: %s", exc)
        return False
    return True
