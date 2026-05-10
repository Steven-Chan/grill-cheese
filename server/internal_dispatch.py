"""HTTP endpoint that dispatches MCP tool calls to the underlying functions.

Used by the stdio shim (server/shim.py) to forward CC's MCP tool calls into
the existing single-process state. Bypasses the streamable-HTTP MCP protocol
to keep the wire format simple (one JSON POST per call, one JSON response).
Bind 127.0.0.1 only — no auth.

Also exposes /internal/telemetry/notify so the shim can record channel-emit
events into the same per-session JSONL log the server writes to.
"""
from __future__ import annotations

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from . import mcp_app
from .telemetry import log_next_call, log_notify


# Whitelisted tool names — must match @mcp.tool() registrations in mcp_app.py
_TOOL_FUNCS = {
    "start_session": mcp_app.start_session,
    "present_branches": mcp_app.present_branches,
    "present_summary": mcp_app.present_summary,
    "record_implicit_decision": mcp_app.record_implicit_decision,
    "resume_session_tool": mcp_app.resume_session_tool,
    "apply_chat_result": mcp_app.apply_chat_result,
    "end_session": mcp_app.end_session,
    "get_session_snapshot": mcp_app.get_session_snapshot,
}


async def internal_tool_endpoint(request: Request) -> Response:
    name = request.path_params.get("name")
    func = _TOOL_FUNCS.get(name)
    if func is None:
        return JSONResponse({"error": f"unknown tool: {name}"}, status_code=404)
    try:
        args = await request.json()
    except Exception:
        return JSONResponse({"error": "bad json"}, status_code=400)
    if not isinstance(args, dict):
        return JSONResponse({"error": "args must be object"}, status_code=400)
    sid = args.get("session_id")
    if isinstance(sid, str) and sid:
        log_next_call(sid, name)
    try:
        result = await func(**args)
    except TypeError as e:
        return JSONResponse({"error": f"bad args: {e}"}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": f"{type(e).__name__}: {e}"}, status_code=500)
    return JSONResponse(result if result is not None else {})


async def internal_notify_endpoint(request: Request) -> Response:
    """POST {session_id, node_id, seq} from shim — log a channel-emit event."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "bad json"}, status_code=400)
    sid = body.get("session_id") or ""
    nid = body.get("node_id") or ""
    seq = body.get("seq")
    if not sid or not nid or not isinstance(seq, int):
        return JSONResponse({"error": "missing session_id/node_id/seq"}, status_code=400)
    log_notify(sid, nid, seq)
    return JSONResponse({"ok": True})
