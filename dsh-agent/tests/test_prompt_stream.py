"""What one prompt yields, including the events that must not reach the UI."""

import asyncio

import pytest

from app.harness import HarnessSession


async def drain(session: HarnessSession, text: str = "hi") -> list[dict]:
    return [event async for event in session.prompt(text)]


def push(session: HarnessSession, *messages: dict) -> None:
    for message in messages:
        session._events.put_nowait(message)


def text_event(session_id: str, text: str) -> dict:
    return {
        "method": "session.event",
        "params": {"sessionId": session_id, "event": {
            "type": "assistant/message",
            "data": {"message": {"content": [{"type": "text", "text": text}]}},
        }},
    }


def status(session_id: str, value: str) -> dict:
    return {"method": "session.status", "params": {"sessionId": session_id, "status": value}}


@pytest.fixture
def session(monkeypatch):
    live = HarnessSession("project-1", "s1")

    async def fake_call(method, params):
        return {"messageId": "m1"}

    monkeypatch.setattr(live, "_call", fake_call)
    return live


async def test_yields_text_then_stops_at_idle(session):
    push(session,
         status("s1", "running"),
         text_event("s1", "done thinking"),
         status("s1", "idle"),
         text_event("s1", "this belongs to a later prompt"))

    events = await drain(session)

    assert [e["type"] for e in events] == ["status", "text", "status"]
    assert events[1]["text"] == "done thinking"
    # The stream stops at idle; the next prompt's events stay queued.
    assert session._events.qsize() == 1


async def test_subagent_text_and_idle_are_ignored(session):
    push(session,
         text_event("subagent-9", "child chatter"),
         status("subagent-9", "idle"),
         text_event("s1", "the real answer"),
         status("s1", "idle"))

    events = await drain(session)

    assert [e.get("text") for e in events if e["type"] == "text"] == ["the real answer"]
    # A descendant going idle must not end the root stream.
    assert events[-1] == {"type": "status", "status": "idle"}


async def test_process_exit_mid_prompt_is_an_error(session):
    push(session, status("s1", "running"), None)  # None is the reader's EOF marker

    with pytest.raises(Exception) as raised:
        await drain(session)
    assert "exited" in str(raised.value)


async def test_one_prompt_at_a_time(session):
    push(session, status("s1", "idle"))
    first = session.prompt("a")
    await first.__anext__()  # take the lock and hold it

    with pytest.raises(Exception) as raised:
        await drain(session, "b")
    assert "already answering" in str(raised.value)
    await first.aclose()
