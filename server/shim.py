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
      "cwd": "/Users/hoyin/Documents/grill-cheese"
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
        _client = httpx.AsyncClient(
            base_url=BASE_URL,
            timeout=httpx.Timeout(120.0),
            headers={"X-Grill-Owner": OWNER_ID},
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
# Buffer for node_committed events that arrive before the stdio session is
# ready (fresh shim subscribing while the SSE ring buffer replays prior
# committed events). Drained as soon as session is set.
_pending_emits: list[dict[str, Any]] = []


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

    body = {
        "session_id": session_id,
        "node_id": node_id,
        "seq": seq,
        "actions": actions,
    }
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


async def _sse_subscriber() -> None:
    """Long-lived task that subscribes to /events and bridges committed events.

    Subscribes with ?owner=<OWNER_ID> so this shim only receives events for
    sessions it created. Without this, every parallel CC instance would
    receive every other instance's channel notifications (global SSE bucket).
    """
    backoff = 1.0
    sse_path = f"/events?owner={OWNER_ID}"
    while True:
        try:
            async with httpx.AsyncClient(base_url=BASE_URL, timeout=None) as c:
                async with aconnect_sse(c, "GET", sse_path) as event_source:
                    _log("SSE connected")
                    backoff = 1.0
                    async for sse in event_source.aiter_sse():
                        if sse.event != "node_committed":
                            continue
                        try:
                            data = json.loads(sse.data)
                        except Exception:
                            continue
                        sess = _session_holder["session"]
                        if sess is None:
                            # buffer until session is ready (will be drained on session start)
                            _pending_emits.append(data)
                            _log(f"buffered node_committed (session not ready); pending={len(_pending_emits)}")
                            continue
                        await _emit_channel(sess, data)
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
            for buf in list(_pending_emits):
                await _emit_channel(session, buf)
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
