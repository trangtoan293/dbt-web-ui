"""Authorization is delegated to dbt-runner, and its answer is passed through."""

import httpx
import pytest
from fastapi import HTTPException

from app import authz


class FakeClient:
    def __init__(self, response=None, error=None) -> None:
        self._response = response
        self._error = error
        self.calls: list[tuple[str, dict]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def get(self, url, headers=None):
        self.calls.append((url, headers or {}))
        if self._error is not None:
            raise self._error
        return self._response


def install(monkeypatch, client: FakeClient) -> FakeClient:
    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **_: client)
    return client


async def test_forwards_the_callers_own_bearer(monkeypatch):
    client = install(monkeypatch, FakeClient(httpx.Response(200, json={"items": []})))

    await authz.authorize_project("p1", "Bearer abc")

    url, headers = client.calls[0]
    assert url.endswith("/files/p1")
    assert headers["Authorization"] == "Bearer abc"


@pytest.mark.parametrize("status", [401, 403, 404])
async def test_refusals_are_passed_through(monkeypatch, status):
    install(monkeypatch, FakeClient(httpx.Response(status)))

    with pytest.raises(HTTPException) as raised:
        await authz.authorize_project("p1", "Bearer abc")
    assert raised.value.status_code == status


async def test_unreachable_runner_is_503_not_authorized(monkeypatch):
    install(monkeypatch, FakeClient(error=httpx.ConnectError("refused")))

    with pytest.raises(HTTPException) as raised:
        await authz.authorize_project("p1", None)
    assert raised.value.status_code == 503


async def test_unexpected_status_is_never_treated_as_authorized(monkeypatch):
    install(monkeypatch, FakeClient(httpx.Response(500)))

    with pytest.raises(HTTPException) as raised:
        await authz.authorize_project("p1", "Bearer abc")
    assert raised.value.status_code == 502
