#!/usr/bin/env python3
"""Check that a persisted session resumes instead of failing the turn.

Needs a dsh installation with a profile that loads this plugin plus
@deepseek-ai/dsh-sdk-jsonrpc-server. No API key: the model call is pointed at a
dead port on purpose, because everything under test happens before it.

    DSH_BIN="node apps/cli/lib/bin.js" DSH_PROFILE=dbtcraft DSH_HOME=... \
      python3 test_resume.py
"""
import json, os, shlex, subprocess, sys, tempfile, threading, time
from pathlib import Path

BIN = shlex.split(os.environ.get("DSH_BIN", "dsh"))
PROFILE = os.environ.get("DSH_PROFILE", "dbtcraft")
HOME = Path(os.environ["DSH_HOME"])
RUN_CWD = os.environ.get("DSH_RUN_CWD")  # where the harness process itself runs
# DSH_LIVE=1 additionally asserts the resumed model actually sees the old turns.
# It needs a real key, which credentials-local reads from $DSH_HOME/.credentials.yaml.
LIVE = os.environ.get("DSH_LIVE") == "1"
SETTLE = float(os.environ.get("DSH_SETTLE", "60" if LIVE else "12"))


def run(session_id: str, text: str, cwd: str, settle: float | None = None) -> list[dict]:
    """One harness process: initialize, prompt, wait, shutdown. Returns its frames."""
    env = dict(os.environ)
    if not LIVE:
        # No key needed offline: everything under test happens before the model call,
        # so point it at a dead port and let the turn end in a transport error.
        env.update(DEEPSEEK_API_KEY="unused", DEEPSEEK_BASE_URL="http://127.0.0.1:9")
    p = subprocess.Popen([*BIN, "--profile", PROFILE], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         text=True, cwd=RUN_CWD, env=env)
    frames: list[dict] = []
    threading.Thread(target=lambda: [frames.append(json.loads(l)) for l in p.stdout if l.strip()],
                     daemon=True).start()

    def send(msg): p.stdin.write(json.dumps(msg) + "\n"); p.stdin.flush()
    send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"cwd": cwd, "provider": "deepseek-official", "model": "deepseek-v4-flash"}})
    time.sleep(2)
    send({"jsonrpc": "2.0", "id": 2, "method": "session/prompt",
          "params": {"sessionId": session_id, "contentBlocks": [{"type": "text", "text": text}]}})
    time.sleep(SETTLE if settle is None else settle)
    send({"jsonrpc": "2.0", "id": 3, "method": "shutdown", "params": {}})
    try:
        p.wait(timeout=25)
    except subprocess.TimeoutExpired:
        p.kill()
    return frames


def assistant_text(frames) -> str:
    """Committed root-session assistant text, in wire order."""
    parts = []
    for f in frames:
        if f.get("method") != "session.event":
            continue
        e = f["params"]["event"]
        if e.get("type") != "assistant/message":
            continue
        # The committed message sits under data.message; same shape the Python
        # SDK's final_response() reads.
        data = e.get("data") or {}
        owner = data["message"] if isinstance(data.get("message"), dict) else data
        for block in owner.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
    return "\n".join(parts)


def turn_errors(frames) -> list[str]:
    out = []
    for f in frames:
        if f.get("method") != "session.event":
            continue
        e = f["params"]["event"]
        if e.get("type") == "turn/end" and e["data"].get("reason", {}).get("kind") == "error":
            out.append(e["data"]["reason"].get("error", {}).get("message", ""))
    return out


def session_log(session_id: str) -> Path:
    hits = list((HOME / "sessions").rglob(f"{session_id}/session.jsonl*"))
    assert len(hits) == 1, f"expected one log for {session_id}, found {hits}"
    return hits[0]


sid = f"resume-check-{os.getpid()}"
work = tempfile.mkdtemp(prefix="dsh-resume-a-")
other = tempfile.mkdtemp(prefix="dsh-resume-b-")

first = run(sid, "the magic word is banana", work)
size = session_log(sid).stat().st_size
assert size > 0, "cold run persisted nothing"

second = run(sid, "what was the magic word", work)
assert not any("already has a persisted log" in m for m in turn_errors(second)), \
    "second process did not resume: " + "; ".join(turn_errors(second))
assert session_log(sid).stat().st_size > size, "second prompt was not appended to the same log"

# A session id from an out-of-process caller must not reach another workspace.
third = run(sid, "leak attempt", other, settle=6.0)
denied = [f for f in third if f.get("id") == 2 and "error" in f]
assert denied and "is persisted under" in denied[0]["error"]["message"], \
    f"cross-workspace resume was not refused: {third}"
assert not list((HOME / "sessions").rglob(f"*{Path(other).name}*")), \
    "refused resume still created a session under the other workspace"

if LIVE:
    # The point of resuming: the model reads the earlier turns, not just the log.
    answer = assistant_text(second).lower()
    assert "banana" in answer, f"resumed model did not recall the first turn: {answer[:400]!r}"
    assert not turn_errors(second), f"live run failed: {turn_errors(second)}"
    print("ok live: the resumed model recalled the first turn")

print("ok: resume appends to the same log, and refuses another workspace's session")
