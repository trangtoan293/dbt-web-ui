"""The harness event vocabulary the UI depends on.

Every payload here is copied from a real session (a live run against
deepseek-v4-flash), because the committed message nests under data.message and
reading data.content instead silently yields empty answers.
"""

from app.harness import normalize


def test_committed_assistant_text():
    event = normalize({
        "method": "session.event",
        "params": {
            "sessionId": "s1",
            "event": {
                "type": "assistant/message",
                "seq": 271,
                "data": {
                    "turn": 1,
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "The magic word was banana"}],
                    },
                },
            },
        },
    })
    assert event == {"type": "text", "text": "The magic word was banana", "session": "s1"}


def test_reasoning_and_chunks_are_dropped():
    for kind in ("assistant/chunk", "request/header", "agent/inbox/spliced", "llm/retry"):
        assert normalize({
            "method": "session.event",
            "params": {"sessionId": "s1", "event": {"type": kind, "data": {}}},
        }) is None


def test_status_carries_its_session():
    assert normalize({
        "method": "session.status",
        "params": {"sessionId": "s1", "status": "idle"},
    }) == {"type": "status", "status": "idle", "session": "s1"}


def test_turn_end_reports_the_failure_reason():
    event = normalize({
        "method": "session.event",
        "params": {
            "sessionId": "s1",
            "event": {
                "type": "turn/end",
                "data": {"turn": 1, "reason": {
                    "kind": "error",
                    "error": {"message": "DeepSeek API request failed", "code": "TRANSPORT"},
                }},
            },
        },
    })
    assert event["type"] == "turn_end"
    assert event["reason"] == "error"
    assert event["error"] == "DeepSeek API request failed"


def test_completed_turn_has_no_error():
    event = normalize({
        "method": "session.event",
        "params": {"sessionId": "s1",
                   "event": {"type": "turn/end", "data": {"reason": {"kind": "completed"}}}},
    })
    assert event["reason"] == "completed" and event["error"] is None


def test_empty_assistant_message_is_not_an_event():
    assert normalize({
        "method": "session.event",
        "params": {"sessionId": "s1", "event": {
            "type": "assistant/message",
            "data": {"message": {"content": [{"type": "thinking", "text": "hmm"}]}},
        }},
    }) is None


def test_tool_call_and_result_pair_by_call_id():
    """Both payloads are copied from a real glob call.

    tool/result carries neither the tool name nor a top-level id: the call id is
    on the message source, so pairing is what the UI has to work with.
    """
    started = normalize({
        "method": "session.event",
        "params": {"sessionId": "s1", "event": {"type": "tool/call", "data": {
            "turn": 1, "step": 1, "callId": "call_00_abc", "name": "glob",
            "arguments": '{"pattern": "models/**/*.sql"}',
        }}},
    })
    assert started == {
        "type": "tool_start", "tool": "glob", "id": "call_00_abc",
        "input": '{"pattern": "models/**/*.sql"}', "session": "s1",
    }

    finished = normalize({
        "method": "session.event",
        "params": {"sessionId": "s1", "event": {"type": "tool/result", "data": {
            "message": {
                "role": "user",
                "source": {"kind": "tool", "callId": "call_00_abc"},
                "content": [{"type": "tool-result", "toolCallId": "call_00_abc",
                             "content": [{"type": "text", "text": "models/first.sql"}],
                             "isError": False}],
            },
        }}},
    })
    assert finished["type"] == "tool_end"
    assert finished["id"] == "call_00_abc"
    assert finished["ok"] is True


def test_failed_tool_result_is_not_ok():
    event = normalize({
        "method": "session.event",
        "params": {"sessionId": "s1", "event": {"type": "tool/result", "data": {
            "message": {
                "source": {"kind": "tool", "callId": "call_1"},
                "content": [{"type": "tool-result", "toolCallId": "call_1",
                             "isError": True,
                             "content": [{"type": "text", "text": "no such file"}]}],
            },
        }}},
    })
    assert event["ok"] is False and event["id"] == "call_1"


def test_text_deltas_stream_as_they_arrive():
    """Payload copied from a real turn: chunk.type text-delta, chunk.text."""
    event = normalize({
        "method": "session.event",
        "params": {"sessionId": "s1", "event": {"type": "assistant/chunk", "data": {
            "turn": 1, "step": 1,
            "chunk": {"type": "text-delta", "index": 0, "text": "orders"},
        }}},
    })
    assert event == {"type": "delta", "text": "orders", "session": "s1"}


def test_reasoning_deltas_are_a_separate_kind():
    event = normalize({
        "method": "session.event",
        "params": {"sessionId": "s1", "event": {"type": "assistant/chunk", "data": {
            "chunk": {"type": "reasoning-delta", "index": 0, "text": "The"},
        }}},
    })
    assert event == {"type": "reasoning", "text": "The", "session": "s1"}


def test_chunk_bookkeeping_is_not_forwarded():
    """block-start/end, usage, finish and tool-call deltas are not UI events.

    tool-call-delta in particular repeats what tool/call already reports, and
    block-end for reasoning repeats every reasoning-delta.
    """
    for chunk in (
        {"type": "block-start", "index": 0, "blockType": "reasoning"},
        {"type": "block-end", "index": 0, "block": {"type": "reasoning", "text": "..."}},
        {"type": "finish", "reason": {"kind": "tool-calls"}},
        {"type": "tool-call-delta", "index": 1, "id": "c1", "name": "glob", "argumentsDelta": "{}"},
    ):
        assert normalize({
            "method": "session.event",
            "params": {"sessionId": "s1",
                       "event": {"type": "assistant/chunk", "data": {"chunk": chunk}}},
        }) is None


def test_usage_becomes_a_token_counter():
    """The panel shows what a turn cost, the way the harness's own UI does."""
    event = normalize({
        "method": "session.event",
        "params": {"sessionId": "s1", "event": {"type": "assistant/chunk", "data": {
            "chunk": {"type": "usage", "usage": {
                "inputTokens": 135, "outputTokens": 63,
                "cacheReadTokens": 7936, "reasoningTokens": 28,
            }},
        }}},
    })
    assert event == {
        "type": "usage", "input_tokens": 135, "output_tokens": 63,
        "cached_tokens": 7936, "reasoning_tokens": 28, "session": "s1",
    }
