"""AUTH_DISABLED short-circuit: require_user must return the fixed local user
without any credentials, and only when the toggle is on."""

import types

import pytest

from app.config import settings
from app.core import auth
from app.core.auth import LOCAL_USER_SUB, LOCAL_USER_EMAIL, require_user
from fastapi import HTTPException


def _fake_request():
    return types.SimpleNamespace(state=types.SimpleNamespace(), headers={})


@pytest.mark.asyncio
async def test_no_auth_returns_local_user_without_credentials(monkeypatch):
    monkeypatch.setattr(settings, "auth_disabled", True)
    req = _fake_request()

    claims = await require_user(req, credentials=None)

    assert claims == {"sub": LOCAL_USER_SUB, "email": LOCAL_USER_EMAIL}
    assert req.state.user_id == LOCAL_USER_SUB


@pytest.mark.asyncio
async def test_auth_enabled_still_requires_credentials(monkeypatch):
    monkeypatch.setattr(settings, "auth_disabled", False)
    req = _fake_request()

    with pytest.raises(HTTPException) as exc:
        await require_user(req, credentials=None)
    assert exc.value.status_code == 401
