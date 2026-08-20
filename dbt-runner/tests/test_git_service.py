import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("STORAGE_DIR", "/tmp/dbt-craft-test-storage")

from fastapi import HTTPException

from app.config import settings
from app.core.crypto import encrypt_secret
from app.models.git import GitCommitRequest, GitPushRequest
from app.routers.git import _get_commit_identity
from app.services.git_service import GitService


class _ProjectService:
    def __init__(self, path: Path):
        self.path = path

    def get_path_or_raise(self, project_id: str) -> Path:
        return self.path


class _RowsResult:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return self._rows


class _CredentialSession:
    def __init__(self, rows):
        self.rows = rows
        self.saved = []
        self.commits = 0

    async def execute(self, statement, params):
        if str(statement).lstrip().upper().startswith("INSERT"):
            self.saved.append(params)
            return _RowsResult([])
        return _RowsResult(self.rows)

    async def commit(self):
        self.commits += 1


class GitServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_commit_uses_authenticated_identity_for_single_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = AsyncMock(
                side_effect=[
                    (0, "models/orders.sql\n", ""),
                    (0, "[main abc123] add orders\n", ""),
                ],
            )
            service = GitService(SimpleNamespace(run=run), _ProjectService(Path(tmp)))

            result = await service.commit(
                GitCommitRequest(project_id="project-1", message="add orders"),
                "Alice Example",
                "alice@example.com",
            )

        self.assertTrue(result["success"])
        self.assertEqual(
            run.await_args_list[1].args[0],
            [
                "git",
                "-c",
                "user.name=Alice Example",
                "-c",
                "user.email=alice@example.com",
                "commit",
                "-m",
                "add orders",
            ],
        )

    async def test_exec_rejects_global_git_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = AsyncMock()
            service = GitService(SimpleNamespace(run=run), _ProjectService(Path(tmp)))

            result = await service.exec_command(
                "project-1", 'config --global user.name "Mallory"'
            )

        self.assertFalse(result["success"])
        self.assertIn("outside the project scope", result["stderr"])
        run.assert_not_awaited()

    async def test_exec_allows_project_local_git_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = AsyncMock(return_value=(0, "", ""))
            service = GitService(SimpleNamespace(run=run), _ProjectService(Path(tmp)))

            result = await service.exec_command(
                "project-1", 'config user.name "Alice Example"'
            )

        self.assertTrue(result["success"])
        run.assert_awaited_once_with(
            ["git", "config", "user.name", "Alice Example"], Path(tmp)
        )

    async def test_push_passes_credentials_in_subprocess_environment_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = AsyncMock(
                side_effect=[
                    (0, "main\n", ""),
                    (0, "https://gitlab.example.com/team/repo.git\n", ""),
                    (0, "false\n", ""),
                    (0, "", ""),
                ],
            )
            service = GitService(SimpleNamespace(run=run), _ProjectService(Path(tmp)))

            result = await service.push(
                GitPushRequest(
                    project_id="project-1",
                    username="alice",
                    token="secret-token",
                )
            )

        self.assertTrue(result["success"])
        push_call = run.await_args_list[3]
        self.assertEqual(push_call.args[0], ["git", "push", "-u", "origin", "main"])
        self.assertEqual(
            push_call.kwargs["env"],
            GitService._get_http_auth_env(
                "https://gitlab.example.com/team/repo.git",
                "alice",
                "secret-token",
            ),
        )
        self.assertNotIn(
            "secret-token",
            " ".join(
                part
                for call in run.await_args_list
                for part in call.args[0]
            ),
        )

    async def test_fetch_passes_credentials_for_all_https_remotes(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = AsyncMock(
                side_effect=[
                    (
                        0,
                        "\n".join(
                            [
                                "origin\thttps://gitlab.example.com/team/repo.git (fetch)",
                                "origin\thttps://gitlab.example.com/team/repo.git (push)",
                                "upstream\thttps://gitlab.example.com/team/upstream.git (fetch)",
                            ]
                        ),
                        "",
                    ),
                    (0, "", ""),
                ],
            )
            service = GitService(SimpleNamespace(run=run), _ProjectService(Path(tmp)))

            result = await service.fetch(
                "project-1",
                username="alice",
                token="secret-token",
            )

        self.assertTrue(result["success"])
        fetch_call = run.await_args_list[1]
        self.assertEqual(fetch_call.args[0], ["git", "fetch", "--all", "--prune"])
        self.assertEqual(fetch_call.kwargs["env"]["GIT_CONFIG_COUNT"], "2")
        self.assertEqual(
            fetch_call.kwargs["env"]["GIT_CONFIG_KEY_0"],
            "http.https://gitlab.example.com/team/repo.git.extraHeader",
        )
        self.assertEqual(
            fetch_call.kwargs["env"]["GIT_CONFIG_KEY_1"],
            "http.https://gitlab.example.com/team/upstream.git.extraHeader",
        )
        self.assertNotIn(
            "secret-token",
            " ".join(
                part
                for call in run.await_args_list
                for part in call.args[0]
            ),
        )

    async def test_fetch_uses_encrypted_stored_credentials_when_request_has_none(self):
        original_key = settings.app_encryption_key
        settings.app_encryption_key = "test-encryption-key"
        try:
            with tempfile.TemporaryDirectory() as tmp:
                run = AsyncMock(
                    side_effect=[
                        (
                            0,
                            "origin\thttps://gitlab.example.com/team/repo.git (fetch)",
                            "",
                        ),
                        (0, "", ""),
                    ],
                )
                session = _CredentialSession(
                    [
                        {
                            "remote_url": "https://gitlab.example.com/team/repo.git",
                            "username": "alice",
                            "token_encrypted": encrypt_secret("stored-token"),
                        }
                    ]
                )
                service = GitService(SimpleNamespace(run=run), _ProjectService(Path(tmp)))

                result = await service.fetch(
                    "11111111-1111-1111-1111-111111111111",
                    session=session,
                    user_id="22222222-2222-2222-2222-222222222222",
                )

            self.assertTrue(result["success"])
            fetch_call = run.await_args_list[1]
            self.assertEqual(fetch_call.args[0], ["git", "fetch", "--all", "--prune"])
            self.assertEqual(fetch_call.kwargs["env"]["GIT_CONFIG_COUNT"], "1")
            self.assertEqual(
                fetch_call.kwargs["env"]["GIT_CONFIG_KEY_0"],
                "http.https://gitlab.example.com/team/repo.git.extraHeader",
            )
            self.assertEqual(len(session.saved), 1)
            self.assertEqual(session.commits, 1)
        finally:
            settings.app_encryption_key = original_key


class CommitIdentityTests(unittest.TestCase):
    def test_identity_prefers_oidc_display_name(self):
        self.assertEqual(
            _get_commit_identity(
                {
                    "name": "Alice Example",
                    "preferred_username": "alice",
                    "email": "alice@example.com",
                }
            ),
            ("Alice Example", "alice@example.com"),
        )

    def test_identity_falls_back_to_preferred_username(self):
        self.assertEqual(
            _get_commit_identity(
                {"preferred_username": "alice", "email": "alice@example.com"}
            ),
            ("alice", "alice@example.com"),
        )

    def test_identity_requires_email(self):
        with self.assertRaises(HTTPException) as raised:
            _get_commit_identity({"preferred_username": "alice"})

        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
