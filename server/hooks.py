"""HTTP endpoints for Claude Code hook events + GUI actions."""
from __future__ import annotations

import json
import time

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .schemas import GuiAction, HookEvent
from .state import store


async def hooks_endpoint(request: Request) -> Response:
    """POST from Claude Code hook script. Best-effort; never blocks Claude."""
    try:
        raw = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "err": "bad json"}, status_code=400)
    if not isinstance(raw, dict):
        return JSONResponse({"ok": False}, status_code=400)
    raw.setdefault("timestamp", time.time())
    # link via env injected by skill: CC sets these in tool_input metadata if available
    tool_input = raw.get("tool_input") or {}
    if isinstance(tool_input, dict):
        raw.setdefault("grill_node_id", tool_input.get("_grill_node_id"))
        raw.setdefault("grill_session_id", tool_input.get("_grill_session_id"))
    try:
        ev = HookEvent.model_validate(raw)
    except Exception:
        return JSONResponse({"ok": False, "err": "schema"}, status_code=400)
    store.attach_hook(ev)
    sid = ev.grill_session_id or ev.session_id
    if sid and sid in store.sessions:
        await store.broadcast(
            sid,
            {
                "type": "hook_event",
                "session_id": sid,
                "payload": ev.model_dump(),
            },
        )
    return JSONResponse({"ok": True})


async def actions_endpoint(request: Request) -> Response:
    """POST from GUI: next / other / mark_rejected / unmark / stop / chat."""
    try:
        raw = await request.json()
        action = GuiAction.model_validate(raw)
    except Exception as e:
        return JSONResponse({"ok": False, "err": str(e)}, status_code=400)

    # Validate commit-style actions surface a 400 if branch_id / note missing,
    # so a buggy client doesn't silently leave the user waiting forever.
    if action.action == "next" and not action.branch_id:
        return JSONResponse(
            {"ok": False, "err": "next requires branch_id"}, status_code=400
        )
    if action.action == "other" and not action.note:
        return JSONResponse(
            {"ok": False, "err": "other requires note"}, status_code=400
        )

    result = store.apply_action(action)
    # Commit-style actions must surface a 400 if session/node lookup failed,
    # else skill side stays stuck in wait_for_action with no error signal.
    if result is None and action.action in ("next", "other", "chat", "stop"):
        return JSONResponse(
            {"ok": False, "err": "invalid session_id or node_id"},
            status_code=400,
        )
    committed = False
    if result is not None and action.action in ("next", "other", "chat"):
        # commit first so node mutations only persist on first-write
        committed = store.set_action(action.node_id, result)
        if committed:
            store.apply_committed(action)
    elif result is not None:
        # stop: commit but no node mutation needed
        committed = store.set_action(action.node_id, result)

    # broadcast state mutation so all clients sync (mark_rejected/unmark
    # mutated in apply_action; next/other mutated above only if committed)
    s = store.get(action.session_id)
    if s and action.node_id in s.nodes:
        await store.broadcast(
            action.session_id,
            {
                "type": "node_updated",
                "session_id": action.session_id,
                "payload": s.nodes[action.node_id].model_dump(),
            },
        )
    if committed and result is not None:
        await store.broadcast(
            action.session_id,
            {
                "type": "node_resolved",
                "session_id": action.session_id,
                "payload": result.model_dump(),
            },
        )
    # chat commits also pause the session — separate broadcast so GUI can
    # show "paused, chatting in CC" banner without conflating with stop/end.
    if committed and action.action == "chat":
        store.pause_session(action.session_id, action.node_id, action.branch_id)
        await store.broadcast(
            action.session_id,
            {
                "type": "session_paused",
                "session_id": action.session_id,
                "payload": {
                    "node_id": action.node_id,
                    "branch_id": action.branch_id,
                },
            },
        )
    return JSONResponse({"ok": True, "committed": committed})


async def sessions_endpoint(request: Request) -> Response:
    """GET list of active sessions."""
    return JSONResponse(
        {
            "sessions": [
                {"id": s.id, "brief": s.brief, "started_at": s.started_at}
                for s in store.sessions.values()
            ]
        }
    )


async def snapshot_endpoint(request: Request) -> Response:
    """GET /snapshot/{sid} → full session state."""
    sid = request.path_params.get("sid", "")
    s = store.get(sid)
    if not s:
        return JSONResponse({"err": "not found"}, status_code=404)
    return JSONResponse(s.model_dump())


async def export_md_endpoint(request: Request) -> Response:
    """GET /export/{sid}.md → markdown summary of decisions."""
    sid = request.path_params.get("sid", "")
    s = store.get(sid)
    if not s:
        return Response("# not found", status_code=404)
    lines = [f"# Grill Session — {s.id}", "", f"**Brief:** {s.brief}", ""]
    if s.root_node_id:
        _render_md(s, s.root_node_id, lines, depth=0, visited=set())
    return Response("\n".join(lines), media_type="text/markdown")


def _render_md(s, node_id, lines, depth, visited):
    if node_id in visited:
        return
    visited.add(node_id)
    n = s.nodes.get(node_id)
    if not n:
        return
    h = "#" * (depth + 2)
    flag = " *(implicit)*" if n.implicit else ""
    lines.append(f"{h} {n.question}{flag}")
    if n.reasoning:
        lines.append(f"> {n.reasoning}")
    lines.append("")
    for b in n.branches:
        marks = []
        if b.is_recommended:
            marks.append("recommended")
        if b.state != "considered":
            marks.append(b.state)
        suffix = f" *({', '.join(marks)})*" if marks else ""
        lines.append(f"- **{b.label}**{suffix}")
        if b.rationale:
            lines.append(f"  - {b.rationale}")
    if n.user_note:
        lines.append("")
        lines.append(f"**User note:** {n.user_note}")
    lines.append("")
    for b in n.branches:
        if b.child_node_id:
            _render_md(s, b.child_node_id, lines, depth + 1, visited)
