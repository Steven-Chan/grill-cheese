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
    WaitForActionResult,
)
from .state import store


mcp = FastMCP("grill-cheese", json_response=True, streamable_http_path="/")


@mcp.tool()
async def start_session(brief: str) -> dict:
    """Start a new grill session. Call once at the very start.

    Args:
        brief: The user's plan / proposal / question to be grilled.
    Returns:
        {session_id, started_at}
    """
    s = store.new_session(brief)
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
    # node_added flips has_pending=true for this session
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
    `{node_id, chosen_branch_id?, chosen_branch_label?, note?, action}`.

    Server buffers GUI clicks and flushes after a 750ms idle window OR
    immediately when a terminal-class click (next/other/stop/chat) lands.

    - `actions == []`  -> TIMEOUT / no flush yet. RE-POLL with the same
                          node_id. Do NOT call present_branches again.
    - `actions == [...]`-> flushed batch. Process the list as a narrative:
                           tagging clicks (mark_rejected, unmark) interleaved
                           with one (or more) terminal clicks at end. The
                           last terminal-class action is the user's final word;
                           earlier entries are 'changed mind' signals.
                           Idempotent — subsequent polls return the same list.
                           Node is now LOCKED — further user clicks rejected.

    Per-item action values: "next" | "other" | "stop" | "chat" |
    "mark_rejected" | "unmark".

    For chat: server has marked session paused. Original node is locked, so
    push a NEW node (or call `end_session`) when ready to continue. Use
    `resume_session_tool` to flip status back to active before pushing.
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
    branch = Branch(label=decision, rationale=rationale, is_recommended=True, state="chosen")
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
            store.clear_node_state(node_id)
    await store.broadcast_session_list()
    return {"ok": True}


@mcp.tool()
async def get_session_snapshot(session_id: str) -> dict:
    """Return current full session state (nodes, hook traces). For debugging or recovery."""
    s = store.get(session_id)
    if not s:
        return {"error": "no such session"}
    return s.model_dump()
