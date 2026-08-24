"""Reading a conversation back out of the harness's session log.

The SDK JSON-RPC wire has no way to list or replay sessions - that belongs to
the harness's own web host. But the log is on disk, append-only and documented,
so the panel can show history and switch conversations by reading it. Nothing
here writes: the harness owns these files.
"""

from __future__ import annotations

import io
import json
import logging
from pathlib import Path

import zstandard

from app.config import settings
from app.harness import normalize

logger = logging.getLogger(__name__)

# One conversation is small; a hard cap keeps a runaway log from becoming a
# request that never ends.
MAX_EVENTS = 20000


def _session_dirs(project_id: str) -> list[Path]:
    root = settings.state_for(project_id) / "sessions"
    if not root.is_dir():
        return []
    # The harness namespaces by working directory, then by session id.
    return [path for path in root.glob("*/*") if path.is_dir()]


def _log_path(directory: Path) -> Path | None:
    for name in ("session.jsonl", "session.jsonl.zstd"):
        candidate = directory / name
        if candidate.is_file():
            return candidate
    return None


def _open_log(path: Path) -> io.TextIOBase:
    """The log as text, decoding the harness's zstd encoding when present.

    `read_across_frames` matters: the harness appends one frame per flush, so
    stopping at the first frame would show only the beginning of a conversation.
    """
    if not path.name.endswith(".zstd"):
        return path.open()
    reader = zstandard.ZstdDecompressor().stream_reader(
        path.open("rb"), read_across_frames=True
    )
    return io.TextIOWrapper(reader, encoding="utf-8", errors="replace")


def _read_events(path: Path) -> list[dict]:
    events: list[dict] = []
    try:
        with _open_log(path) as handle:
            for index, line in enumerate(handle):
                if index >= MAX_EVENTS:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    # A torn tail is normal for an append-only log being written.
                    break
    except (OSError, zstandard.ZstdError) as exc:
        # A log this service cannot decode is one conversation missing from the
        # list, not a broken panel.
        logger.warning("could not read session log %s: %s", path, exc)
        return events
    return events


def _title(events: list[dict]) -> str:
    """The session title the harness derives, else the first thing asked."""
    for event in events:
        if event.get("type") == "session/title":
            title = (event.get("data") or {}).get("title")
            if title:
                return str(title)
    for event in events:
        if event.get("type") != "user/message":
            continue
        source = (event.get("data") or {}).get("source") or {}
        # Skip the runtime context and reminders the harness injects itself.
        if source.get("kind") not in (None, "user", "sdk"):
            continue
        for block in (event.get("data") or {}).get("content") or []:
            text = block.get("text") if isinstance(block, dict) else None
            if text and "system-reminder" not in text and "runtime context" not in text:
                return text.strip().splitlines()[0][:80]
    return "New conversation"


def list_sessions(project_id: str) -> list[dict]:
    """Every conversation this project has, newest first."""
    sessions: list[dict] = []
    for directory in _session_dirs(project_id):
        path = _log_path(directory)
        if path is None:
            continue
        events = _read_events(path)
        if not events:
            continue
        sessions.append({
            "session_id": directory.name,
            "title": _title(events),
            "updated_at": int(path.stat().st_mtime * 1000),
            "turns": sum(1 for event in events if event.get("type") == "turn/start"),
        })
    return sorted(sessions, key=lambda item: item["updated_at"], reverse=True)


def read_history(project_id: str, session_id: str) -> list[dict]:
    """The conversation, in the same event shape the live stream uses.

    Reuses `normalize` so history and live events cannot drift apart, and drops
    the harness's own injected messages: the runtime-context snapshot and skill
    reminders are prompt plumbing, not something a person said.
    """
    directory = next(
        (item for item in _session_dirs(project_id) if item.name == session_id), None
    )
    if directory is None:
        return []
    path = _log_path(directory)
    if path is None:
        return []

    history: list[dict] = []
    for event in _read_events(path):
        kind = event.get("type")
        if kind == "user/message":
            data = event.get("data") or {}
            source = (data.get("source") or {}).get("kind")
            if source not in (None, "user", "sdk"):
                continue
            text = "".join(
                str(block.get("text") or "")
                for block in data.get("content") or []
                if isinstance(block, dict) and block.get("type") == "text"
            )
            if not text or "system-reminder" in text or "Current runtime context" in text:
                continue
            history.append({"type": "prompt", "text": text})
            continue

        # Everything else goes through the live mapping.
        mapped = normalize({"method": "session.event", "params": {"event": event}})
        if mapped is None:
            continue
        mapped.pop("session", None)
        if mapped["type"] in ("text", "tool_start", "tool_end", "todo"):
            history.append(mapped)
    return history
