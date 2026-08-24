"""Reading conversations back out of the harness's session log.

The log lines here are the real shapes, trimmed: this is what a session written
by the harness looks like on disk.
"""

import json

import pytest

from app import sessions as sessions_module
from app.config import settings


def write_log(root, cwd_slug, session_id, events):
    directory = root / "sessions" / cwd_slug / session_id
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "session.jsonl").open("w") as handle:
        for event in events:
            handle.write(json.dumps(event) + "\n")
    return directory


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_dir", tmp_path)
    return "p1"


def user_message(text, kind="user"):
    return {"type": "user/message", "seq": 7,
            "data": {"content": [{"type": "text", "text": text}], "source": {"kind": kind}}}


def assistant_message(text):
    return {"type": "assistant/message", "seq": 9,
            "data": {"message": {"role": "assistant",
                                 "content": [{"type": "text", "text": text}]}}}


def test_lists_conversations_newest_first(project, tmp_path):
    root = settings.state_for(project)
    write_log(root, "--workspace-p1--", "old", [user_message("first question"),
                                                {"type": "turn/start", "data": {"turn": 1}}])
    later = write_log(root, "--workspace-p1--", "new", [user_message("second question")])
    import os
    os.utime(later / "session.jsonl", (10_000_000_000, 10_000_000_000))

    listed = sessions_module.list_sessions(project)

    assert [item["session_id"] for item in listed] == ["new", "old"]
    assert listed[1]["title"] == "first question"
    assert listed[1]["turns"] == 1


def test_prefers_the_title_the_harness_derived(project):
    write_log(settings.state_for(project), "--w--", "s1", [
        user_message("write me a staging model please"),
        {"type": "session/title", "data": {"title": "Staging model"}},
    ])

    assert sessions_module.list_sessions(project)[0]["title"] == "Staging model"


def test_injected_prompt_plumbing_is_not_conversation(project):
    write_log(settings.state_for(project), "--w--", "s1", [
        user_message("real question"),
        user_message("Current runtime context. This snapshot ...", kind="user"),
        user_message("<system-reminder>\nA skill is ...", kind="user"),
        user_message("injected by a plugin", kind="workspace-context"),
        assistant_message("the answer"),
    ])

    history = sessions_module.read_history(project, "s1")

    assert [event["type"] for event in history] == ["prompt", "text"]
    assert history[0]["text"] == "real question"
    assert history[1]["text"] == "the answer"


def test_history_uses_the_same_mapping_as_the_live_stream(project):
    write_log(settings.state_for(project), "--w--", "s1", [
        user_message("make it"),
        {"type": "tool/call", "data": {"callId": "c1", "name": "write",
                                       "arguments": '{"file_path": "models/a.sql"}'}},
        {"type": "tool/result", "data": {"message": {
            "source": {"callId": "c1"},
            "content": [{"type": "tool-result", "toolCallId": "c1", "isError": False}]}}},
        {"type": "assistant/chunk", "data": {"chunk": {"type": "text-delta", "text": "don"}}},
        assistant_message("done"),
    ])

    history = sessions_module.read_history(project, "s1")

    # Deltas are provisional and not replayed; the committed message is.
    assert [event["type"] for event in history] == ["prompt", "tool_start", "tool_end", "text"]
    assert history[1]["tool"] == "write"
    assert history[2]["ok"] is True


def test_a_torn_tail_does_not_lose_the_conversation(project):
    root = settings.state_for(project)
    directory = write_log(root, "--w--", "s1", [user_message("q"), assistant_message("a")])
    with (directory / "session.jsonl").open("a") as handle:
        handle.write('{"type": "assistant/mess')  # crash mid-write

    history = sessions_module.read_history(project, "s1")

    assert [event["type"] for event in history] == ["prompt", "text"]


def test_unknown_session_and_empty_project(project):
    assert sessions_module.read_history(project, "nope") == []
    assert sessions_module.list_sessions(project) == []


def test_reads_the_harness_zstd_encoding_across_frames(project):
    """The harness appends one zstd frame per flush, not one per file."""
    import zstandard

    root = settings.state_for(project)
    directory = root / "sessions" / "--w--" / "s1"
    directory.mkdir(parents=True)
    compressor = zstandard.ZstdCompressor()
    frames = b"".join(
        compressor.compress((json.dumps(event) + "\n").encode())
        for event in (user_message("compressed question"), assistant_message("compressed answer"))
    )
    (directory / "session.jsonl.zstd").write_bytes(frames)

    history = sessions_module.read_history(project, "s1")

    assert [event["type"] for event in history] == ["prompt", "text"]
    assert history[1]["text"] == "compressed answer"
    assert sessions_module.list_sessions(project)[0]["title"] == "compressed question"


def test_an_unreadable_log_is_not_fatal(project):
    root = settings.state_for(project)
    directory = root / "sessions" / "--w--" / "s2"
    directory.mkdir(parents=True)
    (directory / "session.jsonl.zstd").write_bytes(b"not zstd at all")

    assert sessions_module.list_sessions(project) == []
    assert sessions_module.read_history(project, "s2") == []
