"""/system/info exists to surface operational settings, not credentials.

The failure mode this guards is a lazy rewrite that returns `settings.dict()`:
it would hand the browser APP_ENCRYPTION_KEY, which decrypts every stored
warehouse password, plus DATABASE_URL.
"""

import json

import pytest

from app.config import settings
from app.routers.system import system_info

SECRET_FIELDS = (
    "app_encryption_key",
    "database_url",
    "lake_catalog_url",
    "redis_url",
    "oidc_jwks_uri",
)


@pytest.mark.asyncio
async def test_system_info_reports_operational_settings():
    info = await system_info(claims={"sub": "someone"})

    assert info["runs"]["history_retention_days"] == settings.run_history_retention_days
    assert info["runs"]["max_concurrent"] == settings.max_concurrent_dbt_runs
    assert info["scheduler"]["enabled"] == settings.scheduler_enabled
    assert info["auth"]["mode"] in {"oidc", "disabled"}
    assert isinstance(info["adapters"], list) and info["adapters"]


@pytest.mark.asyncio
async def test_system_info_leaks_no_secret():
    secrets = {
        name: getattr(settings, name) for name in SECRET_FIELDS if getattr(settings, name, "")
    }
    # Give every secret a value worth finding, so an empty local config cannot
    # let this pass by accident.
    secrets.setdefault("app_encryption_key", "unset-in-this-environment")

    body = json.dumps(await system_info(claims={"sub": "someone"}))

    assert "app_encryption_key" not in body
    for name, value in secrets.items():
        assert value not in body, f"{name} leaked into /system/info"
