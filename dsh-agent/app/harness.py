"""One DeepSeek Harness process per agent session, driven over JSON-RPC stdio.

The wire is three methods (`initialize`, `session/prompt`, `shutdown`) plus two
notifications (`session.event`, `session.status`), so the client is written here
rather than bridging the synchronous `deepseek-harness-sdk` into asyncio: the
bridge would be more code than the protocol.

Two properties of that wire shape this module:

* There is no cancel and no per-session close (see the plugin's README). Stop
  therefore means killing the process, which is only safe because
  `dsh-session-resume` makes a later process resume the same session id.
* Sessions stay live until shutdown, so a process is one session and the
  registry reclaims idle ones.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import tempfile
import time
from pathlib import Path
from typing import AsyncIterator

import yaml

from app.config import settings
from app.model_config import ModelConfig

logger = logging.getLogger(__name__)

_STDERR_CHUNK = 8192
_STDERR_LINE_MAX = 2000


def normalize(notification: dict) -> dict | None:
    """Map one harness notification to the event the UI consumes.

    Kept pure and small: the UI should not have to learn the harness event
    vocabulary, and everything not listed here is deliberately dropped rather
    than forwarded as noise (raw deltas, request headers, inbox splices).
    """
    method = notification.get("method")
    params = notification.get("params") or {}
    session = params.get("sessionId")

    if method == "session.status":
        return {"type": "status", "status": params.get("status"), "session": session}

    if method != "session.event":
        return None

    event = params.get("event") or {}
    kind = event.get("type")
    data = event.get("data") or {}

    def tagged(event: dict) -> dict:
        return {**event, "session": session}

    if kind == "assistant/chunk":
        # Provisional tokens, streamed so the UI reads like a conversation
        # instead of arriving in one block. They can be retried and replaced:
        # the committed `assistant/message` below is the authoritative text.
        chunk = data.get("chunk") or {}
        if chunk.get("type") == "usage":
            usage = chunk.get("usage") or {}
            return tagged({
                "type": "usage",
                "input_tokens": usage.get("inputTokens"),
                "output_tokens": usage.get("outputTokens"),
                "cached_tokens": usage.get("cacheReadTokens"),
                "reasoning_tokens": usage.get("reasoningTokens"),
            })
        text = chunk.get("text")
        if not text:
            return None
        if chunk.get("type") == "text-delta":
            return tagged({"type": "delta", "text": text})
        if chunk.get("type") == "reasoning-delta":
            return tagged({"type": "reasoning", "text": text})
        return None

    if kind == "assistant/message":
        message = data.get("message") if isinstance(data.get("message"), dict) else data
        text = "".join(
            str(block.get("text") or "")
            for block in (message.get("content") or [])
            if isinstance(block, dict) and block.get("type") == "text"
        )
        return tagged({"type": "text", "text": text}) if text else None

    if kind == "tool/call":
        return tagged({
            "type": "tool_start",
            "tool": data.get("name"),
            "id": data.get("callId"),
            "input": data.get("arguments"),
        })

    if kind == "tool/result":
        # The result carries no tool name and its call id is on the message
        # source, not the event: the UI pairs it with its tool_start by callId.
        message = data.get("message") or {}
        blocks = message.get("content") or []
        results = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool-result"]
        call_id = (message.get("source") or {}).get("callId") or (
            results[0].get("toolCallId") if results else None
        )
        return tagged({
            "type": "tool_end",
            "id": call_id,
            "ok": not any(b.get("isError") for b in results),
        })

    if kind == "todo/write":
        return tagged({"type": "todo", "items": data.get("items") or data.get("todos")})

    if kind == "turn/end":
        reason = data.get("reason") or {}
        return tagged({
            "type": "turn_end",
            "reason": reason.get("kind"),
            "error": (reason.get("error") or {}).get("message"),
        })

    return None


class HarnessError(RuntimeError):
    pass


class HarnessSession:
    """A live harness process bound to one project directory and session id."""

    def __init__(
        self,
        project_id: str,
        session_id: str,
        model_config: ModelConfig | None = None,
    ) -> None:
        self.project_id = project_id
        self.session_id = session_id
        # The caller's own providers and their secrets, configured in the UI and
        # attached by the frontend proxy. Held for the process lifetime because
        # the harness fixes both its adapter config and its environment at spawn;
        # the registry restarts the session when this changes.
        self.model_config = model_config or ModelConfig()
        self.last_used = time.monotonic()
        self.busy = False

        self._process: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task | None = None
        self._stderr_reader: asyncio.Task | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self._events: asyncio.Queue[dict | None] = asyncio.Queue()
        self._next_id = 0
        self._lock = asyncio.Lock()

    # ---- lifecycle -------------------------------------------------------

    @property
    def alive(self) -> bool:
        return self._process is not None and self._process.returncode is None

    def token_path(self) -> Path:
        return settings.state_for(self.project_id) / "mcp-token"

    def overlay_path(self) -> Path:
        """The per-session patch layer configuring this caller's providers."""
        return settings.state_for(self.project_id) / f"providers-{self.session_id}.yml"

    def ready_path(self) -> Path:
        """Written by the dbt MCP shim once the harness has discovered it."""
        return settings.state_for(self.project_id) / f"mcp-ready-{self.session_id}"

    def write_token(self, token: str | None) -> None:
        """Hand the MCP shim the caller's bearer for its dbt-runner calls.

        A file rather than the subprocess environment because the MCP server is
        spawned once per session while the token expires during it; the shim
        re-reads this on every tool call.
        """
        path = self.token_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(token or "")

    async def start(self) -> None:
        state = settings.state_for(self.project_id)
        state.mkdir(parents=True, exist_ok=True)
        os.chmod(state, 0o700)
        cwd = settings.cwd_for(self.project_id)
        if not cwd.is_dir():
            raise HarnessError(f"project directory does not exist: {cwd}")

        env = {
            **os.environ,
            "DSH_HOME": str(settings.dsh_home),
            # Credential references the caller's routes name. The adapter reads
            # exactly these variables, so nothing else has to know their names.
            **self.model_config.credentials,
            # Sessions live with the project, not with the shared profile, so
            # deleting a project takes its conversations with it.
            "DSH_SESSION_ROOT": str(state / "sessions"),
            # The shim resolves its own credentials per call; see write_token.
            "DBT_RUNNER_URL": settings.dbt_runner_url,
            "DBT_RUNNER_TOKEN_FILE": str(self.token_path()),
            "DBT_MCP_READY_FILE": str(self.ready_path()),
            "DBT_PROJECT_ID": self.project_id,
        }
        # A file left by a previous process for this session would read as ready
        # before this one's discovery has happened.
        self.ready_path().unlink(missing_ok=True)
        # An empty value is not "unset" to everything downstream: the DeepSeek
        # adapter used an empty DEEPSEEK_BASE_URL verbatim and every request
        # failed with "request to  failed". Compose writes empty strings for
        # optional variables, so drop them here rather than in every caller.
        env = {key: value for key, value in env.items() if value != ""}
        argv = [*shlex.split(settings.dsh_bin), "--profile", settings.dsh_profile]
        overlay = self.model_config.overlay()
        if overlay is not None:
            # A patch overlay rather than a settings document: it applies to this
            # process only, so one user's routes never reach another's session.
            self.overlay_path().write_text(yaml.safe_dump(overlay, sort_keys=False))
            argv += ["--patch", str(self.overlay_path())]
        else:
            self.overlay_path().unlink(missing_ok=True)
        self._process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(cwd),
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._reader = asyncio.create_task(self._read_loop())
        self._stderr_reader = asyncio.create_task(self._drain_stderr())
        await asyncio.wait_for(
            self._call(
                "initialize",
                {
                    "cwd": str(cwd),
                    # The caller's chosen route, else the deployment's default.
                    "provider": self.model_config.route or settings.provider,
                    "model": self.model_config.model or settings.model,
                },
            ),
            timeout=settings.start_timeout,
        )
        await self._await_mcp_tools()
        logger.info("harness session %s started for project %s", self.session_id, self.project_id)

    async def _await_mcp_tools(self) -> None:
        """Hold the first prompt until the dbt tools exist.

        The harness answers `initialize` as soon as its JSON-RPC plugin
        activates, which can be before its MCP client has finished discovery -
        and a prompt assembled in that window is offered no dbt tools at all,
        silently. Verified: a fast first turn answered without them while a slow
        one picked them up mid-turn.
        """
        deadline = asyncio.get_running_loop().time() + settings.mcp_ready_timeout
        while asyncio.get_running_loop().time() < deadline:
            if self.ready_path().exists():
                return
            if not self.alive:
                raise HarnessError("harness exited before its tools were ready")
            await asyncio.sleep(0.2)
        logger.warning(
            "session %s: dbt tools were not ready within %ss; continuing without them",
            self.session_id,
            settings.mcp_ready_timeout,
        )

    async def close(self) -> None:
        """Kill the process. Its session survives on disk and resumes later."""
        process = self._process
        self._process = None
        for task in (self._reader, self._stderr_reader):
            if task is not None:
                task.cancel()
        self._reader = None
        self._stderr_reader = None
        self.ready_path().unlink(missing_ok=True)
        self.overlay_path().unlink(missing_ok=True)
        if process is None or process.returncode is not None:
            return
        process.kill()
        try:
            await asyncio.wait_for(process.wait(), timeout=10)
        except asyncio.TimeoutError:
            logger.warning("harness session %s did not exit after kill", self.session_id)

    # ---- transport -------------------------------------------------------

    async def _read_loop(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        stdout = self._process.stdout
        try:
            while True:
                line = await stdout.readline()
                if not line:
                    break
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    # stdout is the protocol; anything else is a composition bug
                    # worth seeing rather than silently dropping.
                    logger.warning("non-protocol line on harness stdout: %s", line[:200])
                    continue
                if "id" in message and message.get("method") is None:
                    future = self._pending.pop(message["id"], None)
                    if future is not None and not future.done():
                        future.set_result(message)
                else:
                    await self._events.put(message)
        except asyncio.CancelledError:
            raise
        finally:
            await self._events.put(None)
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(HarnessError("harness process exited"))
            self._pending.clear()

    async def _drain_stderr(self) -> None:
        """Read the harness's stderr, or its children stop working.

        This is not only about seeing diagnostics. The harness inherits stderr
        to the MCP server it spawns; leaving the pipe unread fills the buffer,
        the child blocks on write, and tool discovery never completes - the
        agent then runs with no dbt tools and nothing says why.

        Read in chunks, not lines: a child that writes megabytes without a
        newline would exceed StreamReader's line limit and kill this task, which
        is the same failure again with an extra step.
        """
        assert self._process is not None
        stderr = self._process.stderr
        if stderr is None:
            return
        buffered = b""
        try:
            while True:
                chunk = await stderr.read(_STDERR_CHUNK)
                if not chunk:
                    break
                buffered = self._log_stderr(buffered + chunk)
        except asyncio.CancelledError:
            raise
        finally:
            if buffered:
                self._log_stderr(buffered + b"\n")

    def _log_stderr(self, buffered: bytes) -> bytes:
        """Emit whole lines from the buffer, capping one runaway line."""
        while b"\n" in buffered:
            line, buffered = buffered.split(b"\n", 1)
            if line.strip():
                logger.warning(
                    "harness %s: %s",
                    self.session_id,
                    line[:_STDERR_LINE_MAX].decode(errors="replace").rstrip(),
                )
        if len(buffered) > _STDERR_LINE_MAX:
            logger.warning(
                "harness %s: %s...",
                self.session_id,
                buffered[:_STDERR_LINE_MAX].decode(errors="replace"),
            )
            buffered = b""
        return buffered

    async def _call(self, method: str, params: dict) -> dict:
        if self._process is None or self._process.stdin is None:
            raise HarnessError("harness process is not running")
        self._next_id += 1
        request_id = self._next_id
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        frame = json.dumps(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        )
        self._process.stdin.write(f"{frame}\n".encode())
        await self._process.stdin.drain()
        response = await future
        if "error" in response:
            raise HarnessError(response["error"].get("message") or "harness call failed")
        return response.get("result") or {}

    # ---- prompting -------------------------------------------------------

    async def prompt(self, text: str) -> AsyncIterator[dict]:
        """Send one prompt and yield normalized events until the agent is idle.

        One prompt at a time per session: the wire would accept more, but a
        second prompt's events are indistinguishable from the first's on a
        stream the UI renders as one conversation.
        """
        if self._lock.locked():
            raise HarnessError("this session is already answering a prompt")

        async with self._lock:
            self.busy = True
            self.last_used = time.monotonic()
            deadline = asyncio.get_running_loop().time() + settings.prompt_timeout
            try:
                await self._call(
                    "session/prompt",
                    {
                        "sessionId": self.session_id,
                        "contentBlocks": [{"type": "text", "text": text}],
                    },
                )
                while True:
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        raise HarnessError("prompt timed out")
                    message = await asyncio.wait_for(self._events.get(), timeout=remaining)
                    if message is None:
                        raise HarnessError("harness process exited mid-prompt")
                    event = normalize(message)
                    if event is None:
                        continue
                    # Descendant (subagent) sessions stream on the same wire.
                    # Their text is not this conversation's answer, and their
                    # idle is not this agent's idle.
                    if event.get("session") not in (None, self.session_id):
                        continue
                    event.pop("session", None)
                    yield event
                    if event.get("type") == "status" and event.get("status") == "idle":
                        return
            finally:
                self.busy = False
                self.last_used = time.monotonic()


async def _log_stream(stream, label: str) -> None:
    """Chunked stderr drain for a process with no session of its own."""
    if stream is None:
        return
    try:
        while True:
            chunk = await stream.read(_STDERR_CHUNK)
            if not chunk:
                return
            text = chunk[:_STDERR_LINE_MAX].decode(errors="replace").strip()
            if text:
                logger.warning("harness %s: %s", label, text)
    except asyncio.CancelledError:
        raise


async def verify_composition() -> None:
    """Boot the profile once at startup and fail loud if it cannot serve.

    Worth its two seconds: a composition can answer `initialize` and exit 0 on
    an immediate `shutdown` while entries behind it failed to load - a native
    module missing from the image does exactly that. Checking here turns it into
    a container that never reports healthy, instead of a first prompt without
    tools.
    """
    argv = [*shlex.split(settings.dsh_bin), "--profile", settings.dsh_profile]
    with tempfile.TemporaryDirectory() as sessions:
        process = await asyncio.create_subprocess_exec(
            *argv,
            cwd="/app" if Path("/app").is_dir() else os.getcwd(),
            env={**os.environ, "DSH_HOME": str(settings.dsh_home),
                 "DSH_SESSION_ROOT": sessions},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            frame = json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"cwd": os.getcwd(), "provider": settings.provider,
                           "model": settings.model},
            })
            assert process.stdin is not None and process.stdout is not None
            process.stdin.write(f"{frame}\n".encode())
            await process.stdin.drain()
            line = await asyncio.wait_for(
                process.stdout.readline(), timeout=settings.start_timeout
            )
            if not line or "result" not in json.loads(line):
                stderr = (await process.stderr.read())[-2000:] if process.stderr else b""
                raise HarnessError(
                    f"harness did not initialize (stdout={line!r}): "
                    f"{stderr.decode(errors='replace')}"
                )
            # Same trap as a live session: an undrained stderr pipe blocks the
            # MCP child. Drain it while waiting for a late failure to surface.
            drain = asyncio.create_task(_log_stream(process.stderr, "startup check"))
            await asyncio.sleep(2)
            drain.cancel()
            if process.returncode is not None:
                stderr = (await process.stderr.read())[-2000:] if process.stderr else b""
                raise HarnessError(
                    f"harness exited during startup ({process.returncode}): "
                    f"{stderr.decode(errors='replace')}"
                )
        finally:
            if process.returncode is None:
                process.kill()
            await process.wait()
    logger.info("harness profile %s verified", settings.dsh_profile)
