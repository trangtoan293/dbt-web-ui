"""A webhook URL is a user-supplied host the server fetches.

Which makes the notifier an SSRF surface: without the same host guard the
connection endpoints use, a schedule pointed at the app's own Postgres or at
169.254.169.254 turns run notifications into an internal port scanner.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.host_guard import HostNotAllowed
from app.services.notify import (
    WebhookRejected,
    assert_webhook_allowed,
    build_payload,
    post_run_notification,
)

_RUN = {
    "id": "run-1",
    "project_id": "p1",
    "project_name": "analytics",
    "command": "build",
    "status": "error",
    "models_total": 12,
    "models_error": 2,
    "error_message": "Compilation Error in model dim_customer",
}


class WebhookUrlTest(unittest.IsolatedAsyncioTestCase):
    async def test_non_http_scheme_is_refused(self):
        for url in ("file:///etc/passwd", "gopher://x/1", "ftp://host/x", ""):
            with self.assertRaises(WebhookRejected):
                await assert_webhook_allowed(url)

    async def test_url_without_host_is_refused(self):
        with self.assertRaises(WebhookRejected):
            await assert_webhook_allowed("https:///no-host")

    async def test_host_guard_verdict_is_honoured(self):
        with patch(
            "app.services.notify.assert_host_allowed",
            side_effect=HostNotAllowed("Target host 'db' is not allowed: ours"),
        ):
            with self.assertRaises(WebhookRejected):
                await assert_webhook_allowed("http://db:5432/hook")

    async def test_allowed_host_passes(self):
        with patch("app.services.notify.assert_host_allowed", return_value=None):
            await assert_webhook_allowed("https://hooks.example.com/services/T/B/X")


class PayloadTest(unittest.TestCase):
    def test_carries_text_content_and_structure(self):
        payload = build_payload(_RUN, "nightly build")
        # Slack and Teams read text, Discord reads content, everyone else reads run.
        self.assertIn("nightly build", payload["text"])
        self.assertEqual(payload["text"], payload["content"])
        self.assertIn("analytics", payload["text"])
        self.assertIn("Compilation Error", payload["text"])
        self.assertEqual(payload["run"]["status"], "error")
        self.assertEqual(payload["run"]["id"], "run-1")

    def test_survives_a_sparse_run_row(self):
        payload = build_payload({"status": "error"}, "s")
        self.assertTrue(payload["text"])


class DeliveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_refused_url_is_not_fetched(self):
        client = MagicMock()
        client.post = AsyncMock()
        with patch(
            "app.services.notify.assert_webhook_allowed",
            side_effect=WebhookRejected("nope"),
        ):
            delivered = await post_run_notification(
                "http://db/hook", _RUN, "s", client=client
            )
        self.assertFalse(delivered)
        client.post.assert_not_awaited()

    async def test_http_error_is_reported_not_raised(self):
        response = MagicMock()
        response.status_code = 500
        client = MagicMock()
        client.post = AsyncMock(return_value=response)
        with patch("app.services.notify.assert_webhook_allowed", return_value=None):
            delivered = await post_run_notification(
                "https://example.com/hook", _RUN, "s", client=client
            )
        self.assertFalse(delivered)

    async def test_transport_failure_never_escapes(self):
        # A broken webhook must not turn a finished dbt run into an error.
        client = MagicMock()
        client.post = AsyncMock(side_effect=OSError("connection reset"))
        with patch("app.services.notify.assert_webhook_allowed", return_value=None):
            delivered = await post_run_notification(
                "https://example.com/hook", _RUN, "s", client=client
            )
        self.assertFalse(delivered)

    async def test_successful_delivery(self):
        response = MagicMock()
        response.status_code = 200
        client = MagicMock()
        client.post = AsyncMock(return_value=response)
        with patch("app.services.notify.assert_webhook_allowed", return_value=None):
            delivered = await post_run_notification(
                "https://example.com/hook", _RUN, "nightly", client=client
            )
        self.assertTrue(delivered)
        self.assertEqual(
            client.post.await_args.kwargs["json"]["schedule"], "nightly"
        )


if __name__ == "__main__":
    unittest.main()
