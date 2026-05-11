"""HTTP endpoints for Claude Code hook events + GUI actions."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .schemas import GuiAction, HookEvent
from .state import SUMMARY_END_ACTIONS, TERMINAL_ACTIONS, store
from .telemetry import forget_session

logger = logging.getLogger(__name__)


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


async def wrap_endpoint(request: Request) -> Response:
    """POST /api/sessions/{sid}/wrap — toolbar Wrap-up signal.

    Session-level: no node bound. Marks the session as awaiting verdict-card
    composition + broadcasts session_wrap so the skill wakes and calls
    present_summary. Idempotent on double-click (see Store.wrap_session).
    """
    sid = request.path_params.get("sid", "")
    s = await store.wrap_session(sid)
    if s is None:
        return JSONResponse({"ok": False, "err": "not found or ended"}, status_code=404)
    return JSONResponse({"ok": True})


async def actions_endpoint(request: Request) -> Response:
    """POST from GUI: next / chat / summary verdicts.

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
            # Doc-awareness: implement_now is blocked on summary nodes that
            # Claude flagged as needing docs. Defense-in-depth — GUI hides the
            # button, this gate catches stale clients / API replays.
            if (
                action.action == "implement_now"
                and node_pre.kind == "summary"
                and node_pre.generate_docs
            ):
                return JSONResponse(
                    {"ok": False, "err": "implement_now_blocked"},
                    status_code=400,
                )
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

    # Auto-end keys off the committed action.
    committed = store.get_actions(action.node_id)
    final_action = committed[-1].action if committed else None

    # continue_grill on a wrap summary node un-wraps the session — the user
    # bailed out of the verdict surface; pre-wrap pending node (if any) is
    # eligible to receive picks again.
    if final_action == "continue_grill":
        s_resume = store.get(action.session_id)
        if s_resume and s_resume.wrap_summary_node_id is not None:
            s_resume.wrap_summary_node_id = None
            store._persist(s_resume)

    # Summary-node verdicts auto-end the session server-side. Skill must NOT
    # call end_session for stop_here / create_plan / implement_now.
    if final_action in SUMMARY_END_ACTIONS:
        s2 = store.get(action.session_id)
        if s2:
            # Verdict-with-pending: discard any non-summary node that never
            # got an answer (un-flushed, non-implicit, non-redirected). Clean
            # tree, no audit trail of the abandoned question.
            doomed = [
                nid for nid, n in s2.nodes.items()
                if nid != action.node_id
                and n.kind != "summary"
                and not n.is_flushed
                and not n.implicit
                and not n.redirected
            ]
            for nid in doomed:
                n = s2.nodes.get(nid)
                if n and n.parent_node_id and n.parent_branch_id:
                    parent = s2.nodes.get(n.parent_node_id)
                    if parent:
                        for b in parent.branches:
                            if b.id == n.parent_branch_id and b.child_node_id == nid:
                                b.child_node_id = None
                s2.nodes.pop(nid, None)
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


# Fallback cmux binary names searched on PATH when the session record doesn't
# carry an absolute bin_path (older sessions, or env where the var was missing).
_CMUX_BIN_FALLBACKS = ("cmux",)


async def _run_cmux(
    bin_path: str,
    args: list[str],
    socket_path: str | None,
) -> tuple[int, str]:
    """Shell `cmux ...` with CMUX_SOCKET_PATH set when known. Returns (rc, stderr)."""
    env = dict(os.environ)
    if socket_path:
        env["CMUX_SOCKET_PATH"] = socket_path
    proc = await asyncio.create_subprocess_exec(
        bin_path,
        *args,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=5.0)
    except asyncio.TimeoutError:
        proc.kill()
        # reap the zombie — communicate() was abandoned, so wait explicitly
        await proc.wait()
        return 124, "cmux call timed out"
    return proc.returncode or 0, (stderr or b"").decode("utf-8", "replace")


async def jump_to_cmux_endpoint(request: Request) -> Response:
    """POST /api/sessions/{sid}/jump-to-cmux → focus the cmux pane that hosts
    this session. Two sequential CLI calls: select-workspace, then focus-panel
    (best-effort, missing panel_id falls back to workspace-only)."""
    sid = request.path_params.get("sid", "")
    s = store.get(sid)
    if not s:
        return JSONResponse({"ok": False, "err": "session not found"}, status_code=404)
    if not s.cmux or not s.cmux.workspace_id:
        return JSONResponse(
            {"ok": False, "err": "no cmux coords for this session"},
            status_code=409,
        )
    cmux = s.cmux
    bin_path = cmux.bin_path or _CMUX_BIN_FALLBACKS[0]
    rc, err = await _run_cmux(
        bin_path,
        ["select-workspace", "--workspace", cmux.workspace_id],
        cmux.socket_path,
    )
    if rc != 0:
        logger.warning("cmux select-workspace failed rc=%s err=%s", rc, err[:200])
        return JSONResponse(
            {"ok": False, "err": f"select-workspace rc={rc}: {err[:200]}"},
            status_code=502,
        )
    if cmux.panel_id:
        rc2, err2 = await _run_cmux(
            bin_path,
            [
                "focus-panel",
                "--panel", cmux.panel_id,
                "--workspace", cmux.workspace_id,
            ],
            cmux.socket_path,
        )
        # focus-panel is best-effort — workspace switch already succeeded.
        if rc2 != 0:
            logger.info("cmux focus-panel rc=%s err=%s", rc2, err2[:200])
    return JSONResponse({"ok": True})


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
        if n.generate_docs:
            # Surface the doc-need signal so it survives the export even when
            # user picked stop_here. When user picked create_plan, the plan
            # markdown carries the full design; this section is the audit trail.
            lines.append(f"{h} Docs flagged but not planned")
            lines.append("")
            lines.append(n.docs_reason or "_(no reason given)_")
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
