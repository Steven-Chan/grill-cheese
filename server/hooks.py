"""HTTP endpoints for Claude Code hook events + GUI actions."""
from __future__ import annotations

import json
import time

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .schemas import GuiAction, HookEvent
from .state import SUMMARY_END_ACTIONS, TERMINAL_ACTIONS, store
from .telemetry import forget_session


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
    """POST from GUI: next / stop / chat / summary verdicts.

    Click flow: mutate node state immediately + broadcast node_updated, append
    record to per-node buffer, reset 750ms idle timer. Terminal-class clicks
    flush immediately. On flush the buffer is locked — further clicks 409.
    """
    try:
        raw = await request.json()
        action = GuiAction.model_validate(raw)
    except Exception as e:
        return JSONResponse({"ok": False, "err": str(e)}, status_code=400)

    if action.action == "next" and not action.branch_ids and not (action.note or "").strip():
        return JSONResponse(
            {"ok": False, "err": "next requires branch_ids or note"}, status_code=400
        )

    if store.is_flushed(action.node_id):
        return JSONResponse(
            {"ok": False, "err": "node locked"}, status_code=409
        )

    # picking or chatting on a chat-removed branch is a 409, not 400, so the
    # GUI can show a "this option was removed in a recent chat" toast.
    s_pre = store.get(action.session_id)
    if s_pre:
        node_pre = s_pre.nodes.get(action.node_id)
        if node_pre:
            removed = set(node_pre.removed_branch_ids)
            if action.action == "next" and any(b in removed for b in action.branch_ids):
                return JSONResponse(
                    {"ok": False, "err": "branch_removed"}, status_code=409
                )
            if action.action == "chat" and action.branch_id and action.branch_id in removed:
                return JSONResponse(
                    {"ok": False, "err": "branch_removed"}, status_code=409
                )

    record = store.apply_action(action)
    if record is None:
        # Re-check for the removed-branch case in case apply_chat_result
        # mutated removed_branch_ids between the pre-apply check and now.
        # That race is microsecond-wide but the wrong toast (400 vs 409)
        # is annoying — return the dedicated branch_removed code so the
        # GUI can show the right message.
        s_recheck = store.get(action.session_id)
        if s_recheck:
            n_recheck = s_recheck.nodes.get(action.node_id)
            if n_recheck:
                removed = set(n_recheck.removed_branch_ids)
                if action.action == "next" and any(b in removed for b in action.branch_ids):
                    return JSONResponse(
                        {"ok": False, "err": "branch_removed"}, status_code=409
                    )
                if action.action == "chat" and action.branch_id and action.branch_id in removed:
                    return JSONResponse(
                        {"ok": False, "err": "branch_removed"}, status_code=409
                    )
        return JSONResponse(
            {"ok": False, "err": "invalid session_id, node_id, or branch_ids"},
            status_code=400,
        )

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

    store.enqueue_action(action.session_id, action.node_id, record)

    # Persist node mutations (apply_action mutates chosen_branch_ids /
    # branches; enqueue_action appends to node.pending_actions).
    if s:
        store._persist(s)

    # chat: pause session immediately (preserves chat semantics for GUI banner).
    if action.action == "chat":
        _, changed = store.pause_session(
            action.session_id, action.node_id, action.branch_id
        )
        if changed:
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
            await store.broadcast_session_list()

    # Terminal-class clicks bypass the idle timer.
    if action.action in TERMINAL_ACTIONS:
        store.flush_now(action.session_id, action.node_id)

    # Read the committed record's action (apply_action may remap stop→stop_here
    # when the node is a summary). Auto-end keys off the COMMITTED action,
    # not the raw GuiAction — otherwise the remap silently bypasses auto-end.
    committed = store.get_actions(action.node_id)
    final_action = committed[-1].action if committed else None

    # Summary-node verdicts auto-end the session server-side. Skill must NOT
    # call end_session for stop_here / create_plan / implement_now.
    if final_action in SUMMARY_END_ACTIONS:
        s2 = store.get(action.session_id)
        if s2:
            s2.status = "ended"
        await store.broadcast(
            action.session_id,
            {
                "type": "session_ended",
                "session_id": action.session_id,
                "payload": {"summary": "", "ended_at": time.time()},
            },
        )
        # Skip clearing the summary node itself — its committed_actions still
        # need to feed the channel notif being emitted from _flush above.
        # Other nodes have already been delivered.
        if s2:
            for nid in list(s2.nodes.keys()):
                if nid != action.node_id:
                    store.clear_node_state(action.session_id, nid)
            store._persist(s2)
        forget_session(action.session_id)
        await store.broadcast_session_list()

    return JSONResponse({"ok": True, "queued": True})


async def sessions_endpoint(request: Request) -> Response:
    """GET list of active sessions."""
    return JSONResponse(
        {
            "sessions": [
                {
                    "id": s.id,
                    "title": s.title,
                    "brief": s.brief,
                    "project": s.project,
                    "started_at": s.started_at,
                    "status": s.status,
                    "has_pending": store._has_pending(s.id),
                }
                for s in store.sessions.values()
            ]
        }
    )


async def delete_session_endpoint(request: Request) -> Response:
    """DELETE /sessions/{sid} → move to per-project trash/. Tears down active
    + paused sessions too (GUI confirms first). 204 on success, 404 if no
    such session."""
    sid = request.path_params.get("sid", "")
    ok = await store.delete_session(sid)
    if not ok:
        return JSONResponse({"ok": False, "err": "not found"}, status_code=404)
    forget_session(sid)
    return Response(status_code=204)


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
    title = s.title or s.brief[:80]
    iso = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(s.started_at))
    lines = [
        f"# {title}",
        "",
        f"*Session: {s.id} · started: {iso}*",
        "",
        f"**Brief:** {s.brief}",
        "",
    ]
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
    if n.kind == "summary":
        lines.append(f"{h} Summary")
        if n.summary_body:
            lines.append("")
            lines.append(n.summary_body)
        lines.append("")
        for b in n.branches:
            if b.child_node_id:
                _render_md(s, b.child_node_id, lines, depth + 1, visited)
        return
    flag_parts = []
    if n.implicit:
        flag_parts.append("implicit")
    if n.redirected:
        flag_parts.append("redirected via chat")
    flag = f" *({', '.join(flag_parts)})*" if flag_parts else ""
    lines.append(f"{h} {n.question}{flag}")
    if n.reasoning:
        lines.append(f"> {n.reasoning}")
    # inline chat callouts (oldest first)
    for c in n.chats:
        lines.append("")
        lines.append(f"> **Chat ({c.outcome}):** {c.summary}")
    lines.append("")
    chosen_set = set(n.chosen_branch_ids)
    for b in n.branches:
        marks = []
        if b.is_recommended:
            marks.append("recommended")
        if b.id in chosen_set:
            marks.append("chosen")
        if b.user_authored:
            marks.append("typed")
        if b.id in n.removed_branch_ids:
            marks.append("removed via chat")
        suffix = f" *({', '.join(marks)})*" if marks else ""
        lines.append(f"- **{b.label}**{suffix}")
        if b.rationale and not b.user_authored:
            lines.append(f"  - {b.rationale}")
    lines.append("")
    for b in n.branches:
        if b.child_node_id:
            _render_md(s, b.child_node_id, lines, depth + 1, visited)
