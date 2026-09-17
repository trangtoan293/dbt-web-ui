"""The Dremio connection test must not depend on the catalog API.

`GET /api/v3/user` and `GET /api/v3/catalog` hold the connection open forever on
a coordinator whose sources are slow to enumerate, so a healthy server reported
"Connection timed out". These pin the endpoint and the auth flow instead.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapters.dremio import DremioAdapter


class _Response:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError("raise_for_status on an error the adapter should handle")


class _FakeClient:
    """Records every call so a test can assert what was reached."""

    calls = []

    def __init__(self, posts, **_kwargs):
        self._posts = posts

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def get(self, url, **_kwargs):
        raise AssertionError(f"test_connection must not GET {url}")

    async def post(self, url, **_kwargs):
        _FakeClient.calls.append(url)
        for suffix, response in self._posts.items():
            if url.endswith(suffix):
                return response
        raise AssertionError(f"unexpected POST {url}")


def _client_factory(posts):
    _FakeClient.calls = []
    return lambda **kwargs: _FakeClient(posts, **kwargs)


PASSWORD_CONFIG = {
    "host": "dremio.example",
    "port": 9047,
    "user": "vaultadmin",
    "password": "secret",
}


class DremioTestConnection(unittest.IsolatedAsyncioTestCase):
    async def test_password_auth_logs_in_then_submits_a_query(self):
        factory = _client_factory({
            "/apiv2/login": _Response(200, {"token": "abc"}),
            "/api/v3/sql": _Response(200, {"id": "job-1"}),
        })
        with patch.object(httpx, "AsyncClient", factory):
            result = await DremioAdapter(PASSWORD_CONFIG).test_connection()

        self.assertTrue(result["success"], result)
        self.assertEqual(result["details"]["job_id"], "job-1")
        self.assertEqual(
            _FakeClient.calls,
            [
                "http://dremio.example:9047/apiv2/login",
                "http://dremio.example:9047/api/v3/sql",
            ],
        )

    async def test_bad_password_is_reported_before_any_query(self):
        factory = _client_factory({"/apiv2/login": _Response(401)})
        with patch.object(httpx, "AsyncClient", factory):
            result = await DremioAdapter(PASSWORD_CONFIG).test_connection()

        self.assertFalse(result["success"])
        self.assertIn("Invalid username or password", result["message"])
        self.assertEqual(_FakeClient.calls, ["http://dremio.example:9047/apiv2/login"])

    async def test_pat_auth_submits_a_query_directly(self):
        factory = _client_factory({"/api/v3/sql": _Response(401)})
        with patch.object(httpx, "AsyncClient", factory):
            result = await DremioAdapter({"host": "d", "port": 9047, "pat": "nope"}).test_connection()

        self.assertFalse(result["success"])
        self.assertIn("PAT token", result["message"])
        self.assertEqual(_FakeClient.calls, ["http://d:9047/api/v3/sql"])


if __name__ == "__main__":
    unittest.main()
