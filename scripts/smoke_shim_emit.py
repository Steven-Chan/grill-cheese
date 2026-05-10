"""In-process smoke for shim's channel emit path.

Regression coverage for the silent ValidationError bug where
`ServerNotification(Notification[dict,str](method='notifications/claude/channel'))`
raised pydantic ValidationError -> emit failed silently -> CC never saw a
<channel> block. The fix bypasses ServerNotification and writes a raw
JSONRPCNotification straight through ServerSession.send_message().

Tests:
  1. _emit_channel writes one SessionMessage to the write stream.
  2. Inner message is JSONRPCNotification with method='notifications/claude/channel'.
  3. params.content is JSON-encoded body matching the SSE node_committed payload.
  4. params.meta carries session_id / node_id / seq as strings.
  5. Regression guard: the OLD ServerNotification(Notification[...](...)) path
     still raises ValidationError. If this assertion ever flips to "no raise",
     either the mcp lib widened ServerNotification (great — simplify _emit_channel)
     or the spike-style code path was re-introduced (revert + investigate).

Run: PYTHONPATH=. uv run python -m scripts.smoke_shim_emit
"""
from __future__ import annotations

import asyncio
import json
from contextlib import contextmanager
from types import SimpleNamespace

import anyio
import mcp.types as t

import server.shim as shim_mod
from server.shim import _emit_channel


def _make_event() -> dict:
    return {
        "type": "node_committed",
        "session_id": "abc123",
        "payload": {
            "node_id": "n7",
            "seq": 5,
            "actions": [
                {
                    "node_id": "n7",
                    "chosen_branch_id": "b2",
                    "chosen_branch_label": "Usage-based",
                    "note": None,
                    "action": "next",
                    "chain_markdown": None,
                }
            ],
        },
    }


class _FakeSession:
    """Duck-types ServerSession.send_message — the only method _emit_channel calls."""

    def __init__(self, send_stream) -> None:
        self._send = send_stream

    async def send_message(self, msg) -> None:
        await self._send.send(msg)


@contextmanager
def _stub_http():
    """Replace shim._http so telemetry POST never hits the network. Restore on exit."""
    async def _no_http():
        class _C:
            async def post(self, *a, **k):
                return SimpleNamespace(status_code=200)
        return _C()

    orig = shim_mod._http
    shim_mod._http = _no_http  # type: ignore[assignment]
    try:
        yield
    finally:
        shim_mod._http = orig  # type: ignore[assignment]


async def test_emit_writes_jsonrpc_notification():
    send, recv = anyio.create_memory_object_stream(max_buffer_size=8)
    session = _FakeSession(send)

    with _stub_http():
        await _emit_channel(session, _make_event())

    msg = await recv.receive()
    inner = msg.message.root
    assert isinstance(inner, t.JSONRPCNotification), f"got {type(inner).__name__}"
    assert inner.method == "notifications/claude/channel", inner.method
    assert inner.params is not None
    body = json.loads(inner.params["content"])
    assert body["session_id"] == "abc123"
    assert body["node_id"] == "n7"
    assert body["seq"] == 5
    assert body["actions"][0]["chosen_branch_label"] == "Usage-based"
    meta = inner.params["meta"]
    assert meta == {"session_id": "abc123", "node_id": "n7", "seq": "5"}, meta
    print("[1] emit writes one JSONRPCNotification with channel method + body + meta — PASS")


async def test_emit_does_not_double_write():
    send, recv = anyio.create_memory_object_stream(max_buffer_size=8)
    session = _FakeSession(send)

    with _stub_http():
        await _emit_channel(session, _make_event())

    _ = await recv.receive()
    with anyio.move_on_after(0.05) as scope:
        await recv.receive()
    assert scope.cancel_called, "second message arrived from a single emit"
    print("[2] emit writes exactly one message — PASS")


async def test_seq_none_meta_blank():
    send, recv = anyio.create_memory_object_stream(max_buffer_size=8)
    session = _FakeSession(send)

    ev = _make_event()
    ev["payload"]["seq"] = None
    with _stub_http():
        await _emit_channel(session, ev)
    msg = await recv.receive()
    meta = msg.message.root.params["meta"]
    assert meta["seq"] == "", meta  # seq=None -> blank string in meta
    print("[3] seq=None renders meta.seq='' — PASS")


def test_regression_old_path_still_raises():
    # If this ever stops raising, the mcp lib widened ServerNotification to
    # accept arbitrary methods — at which point _emit_channel can be
    # simplified back to session.send_notification(ServerNotification(...)).
    from pydantic import ValidationError
    try:
        notif = t.Notification[dict, str](
            method="notifications/claude/channel",
            params={"content": "x", "meta": {}},
        )
        t.ServerNotification(notif)
    except ValidationError as e:
        print(f"[4] regression guard: ServerNotification still rejects custom method (ValidationError) — PASS")
        return
    raise AssertionError(
        "ServerNotification(Notification[dict,str](...)) no longer raises ValidationError — "
        "mcp lib may have widened the union. Simplify server/shim.py:_emit_channel "
        "and update this test."
    )


async def main():
    await test_emit_writes_jsonrpc_notification()
    await test_emit_does_not_double_write()
    await test_seq_none_meta_blank()
    test_regression_old_path_still_raises()
    print("\nall shim emit tests passed")


if __name__ == "__main__":
    asyncio.run(main())
