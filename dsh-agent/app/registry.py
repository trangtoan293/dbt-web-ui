"""Live harness sessions, capped and reclaimed.

A session is a Node process holding a model context and an MCP child, so they
are not kept forever. The sweep runs on the way into `acquire()` — the same
shape as dbt-runner's warm worker pools — rather than on a timer, so an idle
deployment does no work.
"""

from __future__ import annotations

import asyncio
import logging
import time

from app.config import settings
from app.harness import HarnessSession
from app.model_config import ModelConfig

logger = logging.getLogger(__name__)


class SessionsFull(RuntimeError):
    """Every session slot is busy answering a prompt."""


class SessionRegistry:
    def __init__(self) -> None:
        self._sessions: dict[tuple[str, str], HarnessSession] = {}
        self._lock = asyncio.Lock()

    async def acquire(
        self, project_id: str, session_id: str, model_config: ModelConfig | None = None
    ) -> HarnessSession:
        async with self._lock:
            key = (project_id, session_id)
            existing = self._sessions.get(key)
            if existing is not None and existing.alive:
                wanted = model_config or ModelConfig()
                if existing.model_config.fingerprint != wanted.fingerprint:
                    # The provider set or a credential changed in the UI. The
                    # harness fixed both its adapter config and its environment
                    # at spawn, so the only way a change takes effect is a fresh
                    # process; the conversation survives in the session log.
                    logger.info("model configuration changed for %s/%s; restarting", *key)
                    await existing.close()
                    self._sessions.pop(key, None)
                else:
                    existing.last_used = time.monotonic()
                    return existing
            elif existing is not None:
                # Died on its own (crash, OOM). Drop it and start clean; the
                # session log on disk is what carries the conversation.
                self._sessions.pop(key, None)

            await self._reclaim()
            if len(self._sessions) >= settings.max_sessions:
                raise SessionsFull(
                    f"all {settings.max_sessions} agent sessions are busy"
                )

            session = HarnessSession(project_id, session_id, model_config)
            await session.start()
            self._sessions[key] = session
            return session

    async def _reclaim(self) -> None:
        """Drop idle sessions, then the least recently used, never a busy one."""
        now = time.monotonic()
        for key, session in list(self._sessions.items()):
            if session.busy:
                continue
            if not session.alive or now - session.last_used > settings.idle_seconds:
                logger.info("reclaiming idle agent session %s/%s", *key)
                await session.close()
                self._sessions.pop(key, None)

        while len(self._sessions) >= settings.max_sessions:
            idle = [(k, s) for k, s in self._sessions.items() if not s.busy]
            if not idle:
                return
            key, session = min(idle, key=lambda item: item[1].last_used)
            logger.info("reclaiming least recently used agent session %s/%s", *key)
            await session.close()
            self._sessions.pop(key, None)

    async def stop(self, project_id: str, session_id: str) -> bool:
        """Kill one session. Its next prompt resumes it from disk."""
        async with self._lock:
            session = self._sessions.pop((project_id, session_id), None)
        if session is None:
            return False
        await session.close()
        return True

    async def shutdown(self) -> None:
        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            await session.close()


registry = SessionRegistry()
