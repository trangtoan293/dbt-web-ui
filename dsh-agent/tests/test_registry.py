"""Session slots: capped, reclaimed, and never taken from a busy prompt."""

import time

import pytest

from app import registry as registry_module
from app.config import settings
from app.model_config import ModelConfig
from app.registry import SessionRegistry, SessionsFull


def config(**credentials) -> ModelConfig:
    return ModelConfig(credentials=credentials)


class FakeSession:
    def __init__(self, project_id, session_id, model_config=None) -> None:
        self.project_id = project_id
        self.session_id = session_id
        self.model_config = model_config or ModelConfig()
        self.last_used = time.monotonic()
        self.busy = False
        self.alive = True
        self.closed = False

    async def start(self) -> None:
        pass

    async def close(self) -> None:
        self.closed = True
        self.alive = False


@pytest.fixture
def registry(monkeypatch):
    monkeypatch.setattr(registry_module, "HarnessSession", FakeSession)
    monkeypatch.setattr(settings, "max_sessions", 2)
    monkeypatch.setattr(settings, "idle_seconds", 900)
    return SessionRegistry()


async def test_same_session_is_reused(registry):
    first = await registry.acquire("p1", "s1")
    second = await registry.acquire("p1", "s1")
    assert first is second


async def test_full_when_every_slot_is_busy(registry):
    for name in ("s1", "s2"):
        session = await registry.acquire("p1", name)
        session.busy = True

    with pytest.raises(SessionsFull):
        await registry.acquire("p1", "s3")


async def test_idle_session_is_reclaimed_to_make_room(registry):
    idle = await registry.acquire("p1", "s1")
    idle.last_used = time.monotonic() - settings.idle_seconds - 1
    busy = await registry.acquire("p1", "s2")
    busy.busy = True

    fresh = await registry.acquire("p1", "s3")

    assert idle.closed and fresh.session_id == "s3"


async def test_least_recently_used_gives_way_before_a_busy_one(registry):
    old = await registry.acquire("p1", "s1")
    old.last_used = time.monotonic() - 10
    busy = await registry.acquire("p1", "s2")
    busy.busy = True

    await registry.acquire("p1", "s3")

    assert old.closed and not busy.closed


async def test_a_dead_process_is_replaced_not_returned(registry):
    session = await registry.acquire("p1", "s1")
    session.alive = False

    replacement = await registry.acquire("p1", "s1")

    assert replacement is not session and replacement.alive


async def test_stop_kills_the_session(registry):
    session = await registry.acquire("p1", "s1")

    assert await registry.stop("p1", "s1") is True
    assert session.closed
    # Stopping an unknown session is not an error - the UI may retry.
    assert await registry.stop("p1", "s1") is False


async def test_a_changed_credential_restarts_the_session(registry):
    """The harness fixes its adapter config and environment at spawn.

    Entering, rotating or clearing a key in the UI therefore only takes effect on
    a fresh process. The conversation is not lost: the session log on disk is
    what the next process resumes from.
    """
    first = await registry.acquire("p1", "s1", config(OPENAI_API_KEY="sk-old"))
    second = await registry.acquire("p1", "s1", config(OPENAI_API_KEY="sk-new"))

    assert first.closed, "the session kept running with the previous credential"
    assert second is not first
    assert second.model_config.credentials == {"OPENAI_API_KEY": "sk-new"}


async def test_the_same_credential_reuses_the_session(registry):
    first = await registry.acquire("p1", "s1", config(OPENAI_API_KEY="sk-same"))
    second = await registry.acquire("p1", "s1", config(OPENAI_API_KEY="sk-same"))

    assert second is first and not first.closed


async def test_clearing_the_credential_also_restarts(registry):
    with_key = await registry.acquire("p1", "s1", config(OPENAI_API_KEY="sk-old"))
    without = await registry.acquire("p1", "s1", None)

    assert with_key.closed and not without.model_config.credentials


async def test_a_changed_route_restarts_the_session(registry):
    """A provider added or repointed in Settings is adapter config, fixed at spawn."""
    first = await registry.acquire("p1", "s1", ModelConfig(
        providers={"openai": {"apiKeyEnv": "OPENAI_API_KEY"}},
        credentials={"OPENAI_API_KEY": "sk"}, route="openai", model="gpt-x",
    ))
    second = await registry.acquire("p1", "s1", ModelConfig(
        providers={"openai": {"apiKeyEnv": "OPENAI_API_KEY", "baseURL": "https://proxy"}},
        credentials={"OPENAI_API_KEY": "sk"}, route="openai", model="gpt-x",
    ))

    assert first.closed and second is not first


async def test_the_same_route_and_model_reuse_the_session(registry):
    made = ModelConfig(providers={"openai": {"apiKeyEnv": "OPENAI_API_KEY"}},
                       credentials={"OPENAI_API_KEY": "sk"}, route="openai", model="gpt-x")
    first = await registry.acquire("p1", "s1", made)
    second = await registry.acquire("p1", "s1", ModelConfig(
        providers={"openai": {"apiKeyEnv": "OPENAI_API_KEY"}},
        credentials={"OPENAI_API_KEY": "sk"}, route="openai", model="gpt-x",
    ))

    assert second is first and not first.closed
