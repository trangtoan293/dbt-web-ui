"""The harness's stderr must be drained, or its children stop working.

This is a regression test for a silent failure: the harness inherits stderr to
the MCP server it spawns, so an unread pipe fills its 64KB buffer, the child
blocks on write, and MCP tool discovery never completes. The agent then runs
with no dbt tools and nothing reports why.

The fake harness below writes more than one pipe buffer to stderr BEFORE
answering the handshake, which is exactly what a chatty child looks like.
"""

import sys
import textwrap
from pathlib import Path

import pytest

from app.config import settings
from app.harness import HarnessSession

FAKE_HARNESS = textwrap.dedent('''
    import json, sys
    sys.stdin.readline()                     # the initialize request
    sys.stderr.write("x" * 8_000_000)        # far past any pipe or reader buffer
    sys.stderr.flush()
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": 1, "result": {}}) + "\\n")
    sys.stdout.flush()
    sys.stdin.readline()                     # stay alive until closed
''')


@pytest.fixture
def fake_harness(tmp_path, monkeypatch):
    script = tmp_path / "fake_harness.py"
    script.write_text(FAKE_HARNESS)
    workspace = tmp_path / "projects"
    (workspace / "p1").mkdir(parents=True)
    monkeypatch.setattr(settings, "dsh_bin", f"{sys.executable} {script}")
    monkeypatch.setattr(settings, "workspace_dir", workspace)
    monkeypatch.setattr(settings, "storage_dir", tmp_path / "storage")
    monkeypatch.setattr(settings, "dsh_home", tmp_path / "home")
    monkeypatch.setattr(settings, "start_timeout", 8)
    monkeypatch.setattr(settings, "mcp_ready_timeout", 1)
    return script


async def test_a_chatty_harness_still_completes_its_handshake(fake_harness):
    session = HarnessSession("p1", "s1")
    try:
        # Without a stderr drain this times out instead: the child blocks on its
        # 200KB write and never sends the initialize response.
        await session.start()
        assert session.alive
    finally:
        await session.close()


async def test_the_token_file_is_owner_only(fake_harness):
    """The MCP shim reads the caller's bearer from this file on every call."""
    session = HarnessSession("p1", "s1")
    session.write_token("Bearer secret-token")

    path = session.token_path()
    assert path.read_text() == "Bearer secret-token"
    assert Path(path).stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700


async def test_start_waits_for_the_dbt_tools_then_proceeds(fake_harness):
    """The first prompt must not be assembled before MCP discovery."""
    import asyncio
    import time

    session = HarnessSession("p1", "s1")

    async def announce_ready_late():
        await asyncio.sleep(0.4)
        path = session.ready_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("4")

    try:
        waiter = asyncio.create_task(announce_ready_late())
        started = time.monotonic()
        await session.start()
        elapsed = time.monotonic() - started
        await waiter
        assert elapsed >= 0.3, "start() returned before the tools were announced"
        assert elapsed < 1.0, "start() waited past the announcement"
    finally:
        await session.close()


async def test_a_stale_readiness_file_does_not_count(fake_harness):
    session = HarnessSession("p1", "s1")
    stale = session.ready_path()
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_text("4")

    try:
        # No shim runs here, so the only way this returns quickly is by trusting
        # the previous process's file. mcp_ready_timeout is 1s in this fixture.
        import time
        started = time.monotonic()
        await session.start()
        assert time.monotonic() - started >= 0.9
    finally:
        await session.close()


async def test_empty_environment_values_are_not_passed_down(fake_harness, monkeypatch):
    """Compose writes empty strings for optional variables.

    An empty DEEPSEEK_BASE_URL is not the same as an unset one to the DeepSeek
    adapter: it used the empty value verbatim and every model request failed
    with "request to  failed".
    """
    seen: dict[str, str] = {}
    real = __import__("asyncio").create_subprocess_exec

    async def spy(*argv, **kwargs):
        seen.update(kwargs.get("env") or {})
        return await real(*argv, **kwargs)

    monkeypatch.setattr("asyncio.create_subprocess_exec", spy)
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "real-key")

    session = HarnessSession("p1", "s1")
    try:
        await session.start()
    finally:
        await session.close()

    assert "DEEPSEEK_BASE_URL" not in seen
    assert seen["DEEPSEEK_API_KEY"] == "real-key"


async def test_the_callers_keys_reach_the_harness_environment(fake_harness, monkeypatch):
    """A user's own credentials, attached per request by the frontend proxy.

    The adapter resolves each route's `apiKeyEnv` from the environment, so the
    reference names are the caller's, not this service's.
    """
    seen: dict[str, str] = {}
    real = __import__("asyncio").create_subprocess_exec

    async def spy(*argv, **kwargs):
        seen.update(kwargs.get("env") or {})
        return await real(*argv, **kwargs)

    monkeypatch.setattr("asyncio.create_subprocess_exec", spy)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "deployment-fallback")

    from app.model_config import ModelConfig
    session = HarnessSession("p1", "s1", ModelConfig(
        providers={"acme": {"apiKeyEnv": "ACME_API_KEY", "api": "openai-completions",
                            "baseURL": "https://g.example/v1", "models": [{"id": "big"}]}},
        credentials={"ACME_API_KEY": "sk-user-own", "DEEPSEEK_API_KEY": "sk-user-deepseek"},
        route="acme", model="big",
    ))
    try:
        await session.start()
    finally:
        await session.close()

    assert seen["ACME_API_KEY"] == "sk-user-own"
    assert seen["DEEPSEEK_API_KEY"] == "sk-user-deepseek", "the user's key must win"

