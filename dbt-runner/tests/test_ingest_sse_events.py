"""The ingest SSE endpoint's wire format, and that it records the run.

_stream_process yields event dicts now, and the endpoint serialises them. The
browser contract is unchanged (`data: {json}\\n\\n` with type log/completed/
error), so this pins the frame format the frontend hook parses as well as the
recorder being driven from the same events.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.core.auth import require_user
from app.main import app
from app.routers import ingest as ingest_router

SOURCE_ROW = {
    "id": "s1",
    "name": "CRM sync",
    "source_type": "sql_database",
    "destination": "ducklake",
    "dataset": "raw_crm",
    "tables": ["customers"],
    "write_disposition": "append",
    "primary_key": None,
    "project_id": "p1",
    "project_connection_id": None,
    "connection_type": "postgresql",
    "host": "src-db",
    "port": 5432,
    "database": "crm",
    "username": "u",
    "password_encrypted": None,
    "extra_config": None,
}

JOB_CONFIG = {
    "pipeline_name": "pipe",
    "pipelines_dir": "/tmp/pipelines",
    "destination": {"kind": "ducklake"},
}


def _frames(body: str) -> list[dict]:
    return [
        json.loads(line[len("data: ") :])
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


class IngestSseTest(unittest.TestCase):
    def setUp(self):
        app.dependency_overrides[require_user] = lambda: {
            "sub": "sub-1",
            "email": "u@example.com",
        }
        self.addCleanup(app.dependency_overrides.clear)

        self.recorder = MagicMock()
        self.recorder.run_id = "run-1"
        self.recorder.start = AsyncMock()
        self.recorder.finish = AsyncMock()

        patches = [
            patch.object(
                ingest_router, "_load_source", AsyncMock(return_value=dict(SOURCE_ROW))
            ),
            patch.object(ingest_router, "resolve_user_id", AsyncMock(return_value="u1")),
            patch.object(ingest_router, "_build_job_config", return_value=JOB_CONFIG),
            patch.object(
                ingest_router, "_RunRecorder", MagicMock(return_value=self.recorder)
            ),
            patch("app.core.db.get_session"),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def _post(self, events):
        async def fake_stream(config, source_id):
            for event in events:
                yield event

        with patch.object(ingest_router, "_stream_process", fake_stream):
            with TestClient(app) as client:
                response = client.post("/sse/ingest/s1", json={})
        return response

    def test_successful_load_streams_and_records(self):
        response = self._post(
            [
                {"type": "log", "message": "[info] loading"},
                {"type": "completed", "dataset": "raw_crm", "row_counts": {"customers": 4}},
            ]
        )
        self.assertEqual(response.status_code, 200)
        frames = _frames(response.text)

        self.assertEqual(frames[0]["type"], "started")
        self.assertEqual(frames[0]["run_id"], "run-1")
        self.assertEqual(frames[1], {"type": "log", "message": "[info] loading"})
        self.assertEqual(frames[-1]["type"], "completed")
        self.assertEqual(frames[-1]["row_counts"], {"customers": 4})

        self.recorder.start.assert_awaited_once()
        status, result, error = self.recorder.finish.await_args.args
        self.assertEqual(status, "success")
        self.assertEqual(result["row_counts"], {"customers": 4})
        self.assertIsNone(error)

    def test_failed_load_is_recorded_as_error(self):
        response = self._post(
            [
                {"type": "log", "message": "boom"},
                {"type": "error", "message": "Ingest failed with exit code 1"},
            ]
        )
        frames = _frames(response.text)
        self.assertEqual(frames[-1]["type"], "error")

        status, _result, error = self.recorder.finish.await_args.args
        self.assertEqual(status, "error")
        self.assertIn("exit code 1", error)

    def test_every_log_line_reaches_the_recorder(self):
        self._post(
            [
                {"type": "log", "message": "one"},
                {"type": "log", "message": "two"},
                {"type": "completed", "row_counts": {}},
            ]
        )
        observed = [call.args[0] for call in self.recorder.observe.call_args_list]
        self.assertEqual(
            [event["message"] for event in observed if event["type"] == "log"],
            ["one", "two"],
        )


if __name__ == "__main__":
    unittest.main()
