"""Stdio MCP shim — bridges CC ↔ existing HTTP grill-cheese server.

Architecture: CC spawns this as a stdio MCP subprocess (required for the
Channels feature). The shim:
  1. Lists/forwards MCP tool calls to the existing uvicorn server's
     /internal/tool/{name} endpoint via plain HTTP.
  2. Subscribes to /events SSE on the HTTP server.
  3. On node_committed events: emits notifications/claude/channel back to
     CC via stdio so Claude wakes (no more blocking wait_for_action).

CC config (~/.claude.json):
    "grill-cheese": {
      "command": "uv",
      "args": ["run","python","-m","server.shim"],
      "cwd": "/absolute/path/to/grill-cheese"
    }

Launch CC:
    claude --dangerously-load-development-channels server:grill-cheese

Env:
    GRILL_CHEESE_HOST (default 127.0.0.1)
    GRILL_CHEESE_PORT (default 7878)
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from typing import Any

import httpx
from httpx_sse import aconnect_sse
from mcp.server.lowlevel import NotificationOptions, Server
from mcp.server.session import ServerSession
from mcp.server.stdio import stdio_server
from mcp.shared.message import SessionMessage
import mcp.types as t
from mcp.types import JSONRPCMessage, JSONRPCNotification

# Tool metadata is reused from the HTTP server's FastMCP instance to keep
# the shim auto-aligned with the canonical tool list.
from server.mcp_app import mcp as _http_mcp


HOST = os.environ.get("GRILL_CHEESE_HOST", "127.0.0.1")
PORT = int(os.environ.get("GRILL_CHEESE_PORT", "7878"))
BASE_URL = f"http://{HOST}:{PORT}"

# Per-shim uuid. Stamped on every session this shim creates (via the
# X-Grill-Owner HTTP header read by internal_dispatch) and used as the
# SSE subscribe filter — keeps parallel CC instances from receiving each
# other's node_committed events. Regenerated on every shim start; old
# sessions become orphaned/unreachable, which is the intended behavior
# (one CC lifecycle = one owner).
OWNER_ID = uuid.uuid4().hex


def _capture_cmux_env() -> str | None:
    """Snapshot cmux deep-link coords from this process's env (inherited from
    the cmux pane that spawned CC -> spawned this shim). Returns a JSON
    string for the X-Grill-Cmux HTTP header, or None when not running under
    cmux. Static for shim lifetime — stamped once on the AsyncClient."""
    workspace = os.environ.get("CMUX_WORKSPACE_ID")
    if not workspace:
        return None
    blob = {
        "workspace_id": workspace,
        # CMUX_PANEL_ID is the split surface CC is running in. Without it
        # focus-panel can't aim — but workspace-only jump is still useful,
        # so accept absence.
        "panel_id": os.environ.get("CMUX_PANEL_ID")
        or os.environ.get("CMUX_SURFACE_ID"),
        "socket_path": os.environ.get("CMUX_SOCKET_PATH"),
        # Absolute binary location exported by cmux so the server doesn't
        # need cmux on its PATH.
        "bin_path": os.environ.get("CMUX_CLAUDE_HOOK_CMUX_BIN")
        or os.environ.get("CMUX_BUNDLED_CLI_PATH"),
    }
    return json.dumps(blob)


CMUX_HEADER = _capture_cmux_env()

# wait_for_action is intentionally NOT exposed: Channels replace it.
EXCLUDED_TOOLS = {"wait_for_action"}

server = Server("grill-cheese")


def _log(msg: str) -> None:
    print(f"[shim] {msg}", file=sys.stderr, flush=True)


# ---- HTTP proxy ----------------------------------------------------------

_client: httpx.AsyncClient | None = None


async def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        headers: dict[str, str] = {"X-Grill-Owner": OWNER_ID}
        if CMUX_HEADER:
            headers["X-Grill-Cmux"] = CMUX_HEADER
        _client = httpx.AsyncClient(
            base_url=BASE_URL,
            timeout=httpx.Timeout(120.0),
            headers=headers,
        )
    return _client


async def _proxy_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    client = await _http()
    try:
        r = await client.post(f"/internal/tool/{name}", json=args)
    except httpx.RequestError as e:
        return {"error": f"http error: {e!r}"}
    if r.status_code != 200:
        return {"error": f"status {r.status_code}: {r.text[:200]}"}
    try:
        return r.json()
    except Exception as e:
        return {"error": f"bad json from server: {e}"}


# ---- Tool registration --------------------------------------------------

def _shim_tool_list() -> list[t.Tool]:
    """Re-export every HTTP-side @mcp.tool() except the excluded ones."""
    tools: list[t.Tool] = []
    tm = getattr(_http_mcp, "_tool_manager", None)
    if tm is None:
        return []
    for impl in tm.list_tools():
        if impl.name in EXCLUDED_TOOLS:
            continue
        tools.append(
            t.Tool(
                name=impl.name,
                description=impl.description or "",
                inputSchema=impl.parameters,
            )
        )
    return tools


_TOOLS = _shim_tool_list()


@server.list_tools()
async def list_tools() -> list[t.Tool]:
    return _TOOLS


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[t.TextContent]:
    if name in EXCLUDED_TOOLS:
        return [t.TextContent(type="text", text=json.dumps({"error": f"tool {name} disabled — channels replace it"}))]
    result = await _proxy_tool(name, arguments)
    return [t.TextContent(type="text", text=json.dumps(result))]


# ---- SSE -> channel notification bridge --------------------------------

_session_holder: dict[str, ServerSession | None] = {"session": None}
# Buffer for SSE events that arrive before the stdio session is ready (fresh
# shim subscribing while the SSE ring buffer replays prior events). Drained
# as soon as session is set. Tagged with the SSE event name so we route to
# the right channel emitter.
_pending_emits: list[tuple[str, dict[str, Any]]] = []


async def _emit_channel(session: ServerSession, event_data: dict[str, Any]) -> None:
    """Map an SSE node_committed envelope to a notifications/claude/channel.

    Sends a raw JSON-RPC notification straight to the session write stream
    instead of going through session.send_notification(ServerNotification(...)).
    ServerNotification is a RootModel over a closed union of standard MCP
    notif types (Cancelled / Progress / LoggingMessage / ResourceUpdated /
    ResourceListChanged / ToolListChanged / PromptListChanged /
    ElicitComplete / TaskStatus). A custom method like
    notifications/claude/channel is NOT in that union -> pydantic
    ValidationError -> silent emit failure (see git blame of this file
    for the prior broken path).
    """
    payload = event_data.get("payload") or {}
    session_id = event_data.get("session_id") or ""
    node_id = payload.get("node_id") or ""
    seq = payload.get("seq")
    actions = payload.get("actions") or []

    body: dict[str, Any] = {
        "session_id": session_id,
        "node_id": node_id,
        "seq": seq,
        "actions": actions,
    }
    # Summary-node doc fields: pass through when present so skill sees them
    # in the channel block (avoids extra get_session_snapshot on create_plan).
    if "generate_docs" in payload:
        body["generate_docs"] = payload["generate_docs"]
    if "docs_reason" in payload:
        body["docs_reason"] = payload["docs_reason"]
    # Reconsider queue snapshot: forward so skill's piggy-back discovery
    # path works (otherwise skill must call get_session_snapshot on every
    # wake to check for queued marks). See ADR-0009.
    if "pending_reconsiders" in payload:
        body["pending_reconsiders"] = payload["pending_reconsiders"]
    # Parked slot hints: forward so main can route sideways at wake time
    # without holding payloads through compaction. See ADR-0010.
    if "parked_slots" in payload:
        body["parked_slots"] = payload["parked_slots"]
    meta = {
        "session_id": str(session_id),
        "node_id": str(node_id),
        "seq": str(seq) if seq is not None else "",
    }
    try:
        jr = JSONRPCNotification(
            jsonrpc="2.0",
            method="notifications/claude/channel",
            params={"content": json.dumps(body), "meta": meta},
        )
        # send_message is the public low-level primitive on ServerSession;
        # equivalent to self._write_stream.send(...) but stable across
        # future internal refactors of the attribute name.
        await session.send_message(SessionMessage(message=JSONRPCMessage(jr)))
        _log(f"emitted channel notif session={session_id} node={node_id} seq={seq}")
    except Exception as e:
        _log(f"channel emit err: {type(e).__name__}: {e}")
        return
    # Telemetry round-trip — best-effort. Failure must not block emit path.
    if isinstance(seq, int) and session_id and node_id:
        try:
            client = await _http()
            await client.post(
                "/internal/telemetry/notify",
                json={"session_id": session_id, "node_id": node_id, "seq": seq},
            )
        except Exception:
            pass


async def _emit_chat_message_channel(
    session: ServerSession, event_data: dict[str, Any]
) -> None:
    """Map an SSE chat_message_added envelope to a notifications/claude/channel.

    Only emit for role=='user' messages — assistant messages originate from
    Claude itself (post_chat_message tool call) and don't need to be echoed
    back to it. Channel payload shape (type=chat_message):
        {type, session_id, node_id, chat_id, msg_id, text, seq}
    """
    payload = event_data.get("payload") or {}
    msg = payload.get("message") or {}
    if msg.get("role") != "user":
        return
    session_id = event_data.get("session_id") or ""
    node_id = payload.get("node_id") or ""
    chat_id = payload.get("chat_id") or ""
    seq = payload.get("seq")
    body: dict[str, Any] = {
        "type": "chat_message",
        "session_id": session_id,
        "node_id": node_id,
        "chat_id": chat_id,
        "msg_id": msg.get("msg_id") or "",
        "text": msg.get("text") or "",
        "seq": seq,
    }
    meta = {
        "session_id": str(session_id),
        "node_id": str(node_id),
        "chat_id": str(chat_id),
        "kind": "chat_message",
    }
    try:
        jr = JSONRPCNotification(
            jsonrpc="2.0",
            method="notifications/claude/channel",
            params={"content": json.dumps(body), "meta": meta},
        )
        await session.send_message(SessionMessage(message=JSONRPCMessage(jr)))
        _log(f"emitted chat_message channel session={session_id} node={node_id} seq={seq}")
    except Exception as e:
        _log(f"chat_message channel emit err: {type(e).__name__}: {e}")
        return
    # Telemetry: same /internal/telemetry/notify endpoint as node_committed
    # emits use. Drives prompt-cache TTL diagnostics — chat-intensive
    # sessions need the same notify trail.
    if isinstance(seq, int) and session_id and node_id:
        try:
            client = await _http()
            await client.post(
                "/internal/telemetry/notify",
                json={"session_id": session_id, "node_id": node_id, "seq": seq},
            )
        except Exception:
            pass


async def _emit_wrap_channel(session: ServerSession, event_data: dict[str, Any]) -> None:
    """Map an SSE session_wrap envelope to a notifications/claude/channel.

    Payload shape is {type:"session_wrap", session_id}. No node, no seq —
    the skill recognises session_wrap by `type` and responds by composing
    a summary recap + calling present_summary.
    """
    session_id = event_data.get("session_id") or ""
    body: dict[str, Any] = {"type": "session_wrap", "session_id": session_id}
    meta = {"session_id": str(session_id), "kind": "session_wrap"}
    try:
        jr = JSONRPCNotification(
            jsonrpc="2.0",
            method="notifications/claude/channel",
            params={"content": json.dumps(body), "meta": meta},
        )
        await session.send_message(SessionMessage(message=JSONRPCMessage(jr)))
        _log(f"emitted session_wrap channel session={session_id}")
    except Exception as e:
        _log(f"wrap channel emit err: {type(e).__name__}: {e}")


async def _emit_chat_accepted_channel(
    session: ServerSession, event_data: dict[str, Any]
) -> None:
    """Map an SSE chat_accepted envelope to a notifications/claude/channel.

    Fires after the GUI Accept commits a chat proposal (refine / redirect).
    Without this wake the skill has no signal Accept fired. Payload shape
    (type=chat_accepted):
        {type, session_id, node_id, chat_id, outcome, redirect_branch_id?}
    redirect_branch_id is set only for outcome==redirect. refine leaves
    the node interactive; the skill picks the next move from the snapshot.
    (`resolve` removed in ADR-0001 — non-blocking chat.)
    """
    payload = event_data.get("payload") or {}
    session_id = event_data.get("session_id") or ""
    node_id = payload.get("node_id") or ""
    chat_id = payload.get("chat_id") or ""
    body: dict[str, Any] = {
        "type": "chat_accepted",
        "session_id": session_id,
        "node_id": node_id,
        "chat_id": chat_id,
        "outcome": payload.get("outcome"),
        "redirect_branch_id": payload.get("redirect_branch_id"),
    }
    meta = {
        "session_id": str(session_id),
        "node_id": str(node_id),
        "chat_id": str(chat_id),
        "kind": "chat_accepted",
    }
    try:
        jr = JSONRPCNotification(
            jsonrpc="2.0",
            method="notifications/claude/channel",
            params={"content": json.dumps(body), "meta": meta},
        )
        await session.send_message(SessionMessage(message=JSONRPCMessage(jr)))
        _log(f"emitted chat_accepted channel session={session_id} node={node_id} outcome={body['outcome']}")
    except Exception as e:
        _log(f"chat_accepted channel emit err: {type(e).__name__}: {e}")
    # No telemetry notify — chat_accepted carries no seq (not on the
    # action-buffer flush counter); /internal/telemetry/notify is keyed on seq.


async def _emit_reconsider_marked_channel(
    session: ServerSession, event_data: dict[str, Any]
) -> None:
    """Map an SSE node_reconsider_marked envelope to a channel notif.

    Only emit on the "marked" transition — the "seen" transition is a
    server-side state flip driven BY this emit's delivery confirm, so
    re-emitting on seen would be circular. Payload shape (type=node_reconsider_marked):
        {type, session_id, node_id}
    No seq — not on the per-session monotonic counter (mark bypasses the
    action-buffer flush path). Skill rule on wake: internalize silently,
    end turn — do NOT push a decision node on this wake. See ADR-0009.
    """
    payload = event_data.get("payload") or {}
    state = payload.get("reconsider_marked")
    if state != "marked":
        return  # ignore seen-flip echo
    session_id = event_data.get("session_id") or ""
    node_id = payload.get("node_id") or ""
    body: dict[str, Any] = {
        "type": "node_reconsider_marked",
        "session_id": session_id,
        "node_id": node_id,
    }
    meta = {
        "session_id": str(session_id),
        "node_id": str(node_id),
        "kind": "node_reconsider_marked",
    }
    try:
        jr = JSONRPCNotification(
            jsonrpc="2.0",
            method="notifications/claude/channel",
            params={"content": json.dumps(body), "meta": meta},
        )
        await session.send_message(SessionMessage(message=JSONRPCMessage(jr)))
        _log(f"emitted node_reconsider_marked channel session={session_id} node={node_id}")
    except Exception as e:
        _log(f"reconsider_marked channel emit err: {type(e).__name__}: {e}")
        return
    # Server flips marked → seen on this delivery confirm (purely visual).
    if session_id and node_id:
        try:
            client = await _http()
            await client.post(
                "/internal/reconsider/seen",
                json={"session_id": session_id, "node_id": node_id},
            )
        except Exception:
            pass


async def _dispatch_emit(session: ServerSession, event_name: str, data: dict[str, Any]) -> None:
    if event_name == "node_committed":
        await _emit_channel(session, data)
    elif event_name == "session_wrap":
        await _emit_wrap_channel(session, data)
    elif event_name == "chat_message_added":
        await _emit_chat_message_channel(session, data)
    elif event_name == "chat_accepted":
        await _emit_chat_accepted_channel(session, data)
    elif event_name == "node_reconsider_marked":
        await _emit_reconsider_marked_channel(session, data)


async def _sse_subscriber() -> None:
    """Long-lived task that subscribes to /events and bridges relevant events.

    Subscribes with ?owner=<OWNER_ID> so this shim only receives events for
    sessions it created. Without this, every parallel CC instance would
    receive every other instance's channel notifications (global SSE bucket).
    """
    backoff = 1.0
    sse_path = f"/events?owner={OWNER_ID}"
    bridged = {"node_committed", "session_wrap", "chat_message_added", "chat_accepted", "node_reconsider_marked"}
    while True:
        try:
            async with httpx.AsyncClient(base_url=BASE_URL, timeout=None) as c:
                async with aconnect_sse(c, "GET", sse_path) as event_source:
                    _log("SSE connected")
                    backoff = 1.0
                    async for sse in event_source.aiter_sse():
                        if sse.event not in bridged:
                            continue
                        try:
                            data = json.loads(sse.data)
                        except Exception:
                            continue
                        sess = _session_holder["session"]
                        if sess is None:
                            _pending_emits.append((sse.event, data))
                            _log(f"buffered {sse.event} (session not ready); pending={len(_pending_emits)}")
                            continue
                        await _dispatch_emit(sess, sse.event, data)
        except Exception as e:
            _log(f"SSE loop err: {type(e).__name__}: {e}; reconnect in {backoff:.1f}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


# ---- Main ---------------------------------------------------------------

async def main() -> None:
    init_opts = server.create_initialization_options(
        notification_options=NotificationOptions(),
        experimental_capabilities={"claude/channel": {}},
    )

    _log(f"shim owner_id={OWNER_ID}")
    # Pre-flight: HTTP server reachable?
    try:
        async with httpx.AsyncClient(base_url=BASE_URL, timeout=5.0) as c:
            r = await c.get("/sessions")
            if r.status_code != 200:
                _log(f"WARNING: /sessions returned {r.status_code} — server may be unhealthy")
    except Exception as e:
        _log(f"FATAL: cannot reach grill-cheese HTTP server at {BASE_URL}: {e!r}")
        _log("Start it with: uv run python -m server.server")
        sys.exit(1)

    async with stdio_server() as (read_stream, write_stream):
        # ServerSession is constructed manually (not via server.run) so we
        # can hold a handle and emit notifications from the SSE bridge task
        # outside any tool-call context. server.run() builds + owns its own
        # ServerSession internally and would not expose it.
        async with ServerSession(read_stream, write_stream, init_opts) as session:
            _session_holder["session"] = session
            # Drain anything the SSE bridge buffered while session was None
            # (e.g. ring-buffer replay on subscribe before this point).
            for ev_name, buf in list(_pending_emits):
                await _dispatch_emit(session, ev_name, buf)
            _pending_emits.clear()
            # Start the SSE subscriber AFTER session is set so its first
            # delivery doesn't race the holder write. Buffering above is
            # belt-and-suspenders for shim-restart cases.
            sse_task = asyncio.create_task(_sse_subscriber())
            try:
                # _handle_message is a private mcp lib method — used here
                # because server.run() doesn't let us pre-create the session
                # for outside-of-tool notification emission. If mcp lib
                # rev'ing breaks this signature, see server.run() in
                # mcp/server/lowlevel/server.py for the canonical loop.
                async for message in session.incoming_messages:
                    await server._handle_message(message, session, {}, raise_exceptions=False)
            finally:
                _session_holder["session"] = None
                sse_task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
