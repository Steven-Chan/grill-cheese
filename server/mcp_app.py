"""MCP tools exposed to Claude Code."""
from __future__ import annotations

import asyncio
import json
import time
from typing import Optional

from mcp.server.fastmcp import FastMCP

from .schemas import (
    AskBranchesResult,
    Branch,
    ChatOps,
    WaitForActionResult,
)
from .state import store


mcp = FastMCP("grill-cheese", json_response=True, streamable_http_path="/")


@mcp.tool()
async def start_session(brief: str, project: str) -> dict:
    """Start a new grill session. Call once at the very start.

    Args:
        brief: The user's plan / proposal / question to be grilled.
        project: Repo / directory slug for on-disk session path partitioning.
                 Skill should pass `git rev-parse --show-toplevel | xargs basename`
                 (or cwd basename as fallback). Required.
    Returns:
        {session_id, started_at}
    """
    if not project or not project.strip():
        return {"error": "project must be a non-empty string"}
    project = project.strip()
    s = store.new_session(brief, project)
    await store.broadcast(
        s.id,
        {
            "type": "session_started",
            "session_id": s.id,
            "payload": {"brief": brief, "started_at": s.started_at},
        },
    )
    await store.broadcast_session_list()
    return {"session_id": s.id, "started_at": s.started_at}


@mcp.tool()
async def present_branches(
    session_id: str,
    question: str,
    branches: list[dict],
    reasoning: str = "",
    parent_node_id: Optional[str] = None,
    parent_branch_id: Optional[str] = None,
    depth: int = 0,
    implicit: bool = False,
) -> dict:
    """Push a decision node to the GUI. Returns immediately with {node_id}.

    Pair with wait_for_action(node_id) — long-poll loop — to get the user's
    action. NEVER call this twice for the same logical question; if you need
    to resume after a transport timeout, just call wait_for_action again on
    the existing node_id.

    Each branch is {label, rationale?, is_recommended?}. 2-4 branches.
    Mark exactly one branch is_recommended: true.
    """
    branch_objs = [Branch(**b) for b in branches]
    # Pushing a node implicitly resumes a paused session — the user is back
    # to grilling. Broadcast first so GUI clears the paused banner before
    # the new node arrives.
    if store.resume_session(session_id) is not None:
        await store.broadcast(
            session_id,
            {
                "type": "session_resumed",
                "session_id": session_id,
                "payload": {},
            },
        )
        await store.broadcast_session_list()
    node = store.add_node(
        sid=session_id,
        question=question,
        reasoning=reasoning,
        branches=branch_objs,
        parent_node_id=parent_node_id,
        parent_branch_id=parent_branch_id,
        depth=depth,
        implicit=implicit,
    )
    await store.broadcast(
        session_id,
        {
            "type": "node_added",
            "session_id": session_id,
            "payload": node.model_dump(),
        },
    )
    # add_node mutated parent.branches[parent_branch_id].child_node_id —
    # broadcast the parent so the frontend can draw the edge.
    await _broadcast_parent_update(session_id, parent_node_id)
    # node_added flips has_pending=true for this session
    await store.broadcast_session_list()
    return {"node_id": node.id}


async def _broadcast_parent_update(session_id: str, parent_node_id: Optional[str]) -> None:
    if not parent_node_id:
        return
    s = store.get(session_id)
    if not s:
        return
    parent = s.nodes.get(parent_node_id)
    if not parent:
        return
    await store.broadcast(
        session_id,
        {
            "type": "node_updated",
            "session_id": session_id,
            "payload": parent.model_dump(),
        },
    )


@mcp.tool()
async def present_summary(
    session_id: str,
    summary: str,
    parent_node_id: Optional[str] = None,
    parent_branch_id: Optional[str] = None,
) -> dict:
    """Push a SUMMARY node (verdict card) to the GUI. Returns {node_id}.

    Symmetric to present_branches: returns instantly; pair with wait_for_action
    long-poll. The user picks one of four verdict actions:

      - stop_here      -> approve, no follow-up signal. Server auto-ends.
      - create_plan    -> approve, write detailed implementation plan first.
                          Server auto-ends. Result carries chain_markdown.
      - implement_now  -> approve, start coding immediately.
                          Server auto-ends. Result carries chain_markdown.
      - continue_grill -> keep grilling. Optional note carries user's
                          redirect. Result has chosen_branch_id pointing to
                          a synthetic continuation branch — pass it as
                          parent_branch_id on your next present_branches.

    `summary` is markdown. Render breathing room — multi-paragraph, bullets,
    headings welcome.

    For stop_here / create_plan / implement_now: do NOT call end_session.
    Server has already ended the session.
    """
    # Pushing a summary implicitly resumes a paused session.
    if store.resume_session(session_id) is not None:
        await store.broadcast(
            session_id,
            {
                "type": "session_resumed",
                "session_id": session_id,
                "payload": {},
            },
        )
        await store.broadcast_session_list()
    node = store.add_node(
        sid=session_id,
        question="",
        reasoning="",
        branches=[],
        parent_node_id=parent_node_id,
        parent_branch_id=parent_branch_id,
        depth=0,
        kind="summary",
        summary_body=summary,
    )
    await store.broadcast(
        session_id,
        {
            "type": "node_added",
            "session_id": session_id,
            "payload": node.model_dump(),
        },
    )
    await _broadcast_parent_update(session_id, parent_node_id)
    await store.broadcast_session_list()
    return {"node_id": node.id}


@mcp.tool()
async def wait_for_action(
    session_id: str,
    node_id: str,
    timeout_seconds: float = 50.0,
) -> dict:
    """Long-poll for the user's batched actions on a node.

    Blocks up to timeout_seconds (kept under CC's MCP HTTP timeout ~60s).
    Returns `{node_id, actions: [...]}` where each action item carries
    `{node_id, chosen_branch_id?, chosen_branch_label?, note?, action,
    chain_markdown?}`.

    Server buffers GUI clicks and flushes after a 750ms idle window OR
    immediately when a terminal-class click lands.

    - `actions == []`  -> TIMEOUT / no flush yet. RE-POLL with the same
                          node_id. Do NOT call present_branches again.
    - `actions == [...]`-> flushed batch. Usually a single terminal click;
                           may carry earlier 'other' / chat events buffered
                           in the same idle window. The last terminal-class
                           action is the user's final word.
                           Idempotent — subsequent polls return the same list.
                           Node is now LOCKED — further user clicks rejected.

    Per-item action values: "next" | "other" | "stop" | "chat" |
    "stop_here" | "create_plan" | "implement_now" | "continue_grill".

    For chat: server has marked session paused. Original node is locked.
    When user signals "back to grilling", call `apply_chat_result` with the
    chat outcome (refine/redirect/resolve), summary, and ops (for refine).
    Server unlocks the node + resumes session as part of apply. Old explicit
    `resume_session_tool` is kept as an escape hatch but apply_chat_result
    is the standard path.

    Summary-node verdicts (stop_here / create_plan / implement_now) AUTO-END
    the session server-side. Do NOT call end_session for those. The
    create_plan and implement_now actions also carry `chain_markdown` — the
    full chosen-path recap as markdown — for downstream plan-write or coding.
    """
    deadline = asyncio.get_event_loop().time() + timeout_seconds
    while True:
        existing = store.get_actions(node_id)
        if existing is not None:
            return WaitForActionResult(
                node_id=node_id, actions=existing
            ).model_dump()

        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            return WaitForActionResult(node_id=node_id, actions=[]).model_dump()

        node_event = store.get_event(node_id)
        try:
            await asyncio.wait_for(node_event.wait(), timeout=remaining)
        except asyncio.TimeoutError:
            return WaitForActionResult(node_id=node_id, actions=[]).model_dump()
        # loop: re-check committed batch


# NOTE: ask_branches was removed. It was a single-call wrapper around
# present_branches + wait_for_action, but if CC's transport retried it after a
# 60s timeout the wrapper would create a NEW node on every retry — the exact
# duplicate-node bug we are trying to fix. Use present_branches +
# wait_for_action explicitly. The skill enforces this pattern.


@mcp.tool()
async def record_implicit_decision(
    session_id: str,
    decision: str,
    rationale: str = "",
    parent_node_id: Optional[str] = None,
) -> dict:
    """Record a decision Claude made silently without grilling the user.

    Surfaced as a flagged node in the GUI's Implicit Decisions lane.
    Non-blocking. Use sparingly — every implicit decision is a missed grill opportunity.
    """
    branch = Branch(label=decision, rationale=rationale, is_recommended=True)
    node = store.add_node(
        sid=session_id,
        question=f"(implicit) {decision}",
        reasoning=rationale,
        branches=[branch],
        parent_node_id=parent_node_id,
        parent_branch_id=None,
        depth=0,
        implicit=True,
    )
    # mark the synthetic branch chosen so chosen-path walk picks it up
    node.chosen_branch_id = branch.id
    # add_node persisted before chosen_branch_id was set — re-persist so the
    # mutation lands on disk for rehydration.
    s_persist = store.get(session_id)
    if s_persist:
        store._persist(s_persist)
    await store.broadcast(
        session_id,
        {
            "type": "node_added",
            "session_id": session_id,
            "payload": node.model_dump(),
        },
    )
    return {"node_id": node.id}


@mcp.tool()
async def resume_session_tool(session_id: str) -> dict:
    """Flip a paused session back to active.

    Call this when the user signals "resume" / "back to grilling" / similar
    in CC chat after an earlier `chat` action paused the session.

    The chatted node is LOCKED (chat triggered an immediate buffer flush).
    Do NOT re-poll `wait_for_action` on it — that returns the already
    committed batch instantly. After resume, push a NEW `present_branches`
    to keep grilling, or call `end_session` if the user is done.

    No-op if session is not paused.
    """
    if store.resume_session(session_id) is None:
        return {"ok": False, "err": "session not paused"}
    await store.broadcast(
        session_id,
        {
            "type": "session_resumed",
            "session_id": session_id,
            "payload": {},
        },
    )
    await store.broadcast_session_list()
    return {"ok": True}


@mcp.tool()
async def apply_chat_result(
    session_id: str,
    node_id: str,
    chat_id: str,
    chat_summary: str,
    outcome: str,
    ops: Optional[dict] = None,
) -> dict:
    """Land a chat outcome on the chatted node and resume the session.

    Call this when the user signals "back to grilling" / "resume" in CC chat
    after an earlier `chat` action paused the session. Picks ONE outcome
    from the chat narrative and bakes it into the node:

      - refine   : node stays; ops mutate branches (adds, removes). Original
                   branches NOT touched unless explicitly removed. removes
                   are SOFT — branches stay in node.branches but are tagged
                   in node.removed_branch_ids and rendered greyed/struck.
                   To "edit" a branch, remove the old + add a new one.
      - redirect : node abandoned. node.redirected = True. Push a fresh
                   present_branches AFTER this call for the new question.
      - resolve  : chat itself is the answer. Server synthesizes a chosen
                   branch (label = first 60 chars of summary). Future
                   children chain off this synthetic branch.

    `chat_id` is a UUID YOU generate for this chat (e.g. uuid.uuid4().hex).
    Used for idempotency: if the same chat_id is re-applied (e.g. CC retried
    on transport failure), the server returns success without re-mutating.

    `ops` shape (refine only): {"adds": [{"label","rationale","is_recommended"}],
    "removes": ["branch_id", ...]}. All-or-nothing: any unknown branch_id in
    `removes` returns an error and NO mutation lands. Submit a fresh snapshot
    + retry.

    Returns {ok, node_id, err?, redirect_branch_id?}. On err: nothing
    applied; resubmit. On success: node_updated SSE broadcast carries the
    mutated node. Server has resumed the session AND unlocked the node
    (refine/resolve) so the user can keep clicking.

    For redirect: response includes `redirect_branch_id` — the synthesized
    branch on the chatted node. You MUST pass this as `parent_branch_id`
    on the next `present_branches` call. Without it the post-redirect
    question would render disconnected from the chatted node.
    """
    if outcome not in ("refine", "redirect", "resolve"):
        return {"ok": False, "err": f"bad outcome: {outcome}"}
    parsed_ops: Optional[ChatOps] = None
    if outcome == "refine":
        try:
            parsed_ops = ChatOps.model_validate(ops or {})
        except Exception as e:
            return {"ok": False, "err": f"bad ops: {e}"}

    node, redirect_branch_id, err = store.apply_chat_result(
        sid=session_id,
        node_id=node_id,
        chat_id=chat_id,
        chat_summary=chat_summary,
        outcome=outcome,
        ops=parsed_ops,
    )
    if err is not None or node is None:
        return {"ok": False, "err": err or "apply failed"}

    # broadcast: node payload is the canonical post-mutation state. GUI's
    # existing replace-node-by-id (node_updated handler) renders it.
    await store.broadcast(
        session_id,
        {
            "type": "node_updated",
            "session_id": session_id,
            "payload": node.model_dump(),
        },
    )
    # session is now active again — broadcast resume so banner clears
    await store.broadcast(
        session_id,
        {
            "type": "session_resumed",
            "session_id": session_id,
            "payload": {},
        },
    )
    await store.broadcast_session_list()
    result: dict = {"ok": True, "node_id": node_id}
    if redirect_branch_id:
        # Caller MUST pass this as parent_branch_id on the next
        # present_branches call so the post-redirect question wires to
        # the chatted node on canvas + chain walks.
        result["redirect_branch_id"] = redirect_branch_id
    return result


@mcp.tool()
async def end_session(session_id: str, summary: str = "") -> dict:
    """End the grill session. Final summary is broadcast to GUI."""
    s = store.get(session_id)
    if s:
        s.status = "ended"
    await store.broadcast(
        session_id,
        {
            "type": "session_ended",
            "session_id": session_id,
            "payload": {"summary": summary, "ended_at": time.time()},
        },
    )
    # release per-node action / event entries for nodes in this session
    if s:
        for node_id in list(s.nodes.keys()):
            store.clear_node_state(session_id, node_id)
        store._persist(s)
    await store.broadcast_session_list()
    return {"ok": True}


@mcp.tool()
async def get_session_snapshot(session_id: str) -> dict:
    """Return current full session state (nodes, hook traces). For debugging or recovery."""
    s = store.get(session_id)
    if not s:
        return {"error": "no such session"}
    return s.model_dump()
