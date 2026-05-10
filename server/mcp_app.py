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
    return {"node_id": node.id}


@mcp.tool()
async def wait_for_action(
    session_id: str,
    node_id: str,
    timeout_seconds: float = 50.0,
) -> dict:
    """Long-poll for the user's action on a node previously pushed via present_branches.

    Blocks up to timeout_seconds (kept under CC's MCP HTTP timeout ~60s).
    Returns {node_id, chosen_branch_id?, chosen_branch_label?, note?, action}
    where chosen_branch_label echoes the label of the chosen branch (so the
    skill never has to map the opaque chosen_branch_id back to an option),
    and action is one of:
      - "next"  -> user clicked a branch. `chosen_branch_id` is set; `note`
                   may carry an optional comment.
      - "other" -> user typed free text instead of picking a branch.
                   `note` carries the text; `chosen_branch_id` is None. Read
                   the note like a /grill-me text answer and let it drive the
                   next question (drill or move sideways — your call).
      - "stop"  -> user is done. End the session.
      - "chat"  -> user wants to PAUSE the grill loop and continue chatting in
                   Claude Code about this node. `chosen_branch_id` is set when
                   the chat is scoped to a specific branch (per-branch button);
                   None when scoped to the node itself. The server has marked
                   the session paused. Do NOT call `end_session` — the session
                   is still alive. Stop pushing nodes; continue the conversation
                   in plain chat about the node (and the pinned branch, if any).
                   When the user signals "back to grilling", call
                   `present_branches` again on the same `session_id` — the
                   server auto-resumes status to active.
      - "skip"  -> TIMEOUT, no user action yet. CALL THIS TOOL AGAIN with the
                   same node_id to keep waiting. Do NOT generate a new question.

    Once a user action arrives, this function is idempotent on subsequent calls.
    """
    # If already committed, return immediately (handles retry / re-poll cleanly).
    existing = store.get_action(node_id)
    if existing is not None:
        return existing.model_dump()

    event = store.get_event(node_id)
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        return AskBranchesResult(node_id=node_id, action="skip").model_dump()

    result = store.get_action(node_id) or AskBranchesResult(
        node_id=node_id, action="skip"
    )
    return result.model_dump()


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
async def end_session(session_id: str, summary: str = "") -> dict:
    """End the grill session. Final summary is broadcast to GUI."""
    await store.broadcast(
        session_id,
        {
            "type": "session_ended",
            "session_id": session_id,
            "payload": {"summary": summary, "ended_at": time.time()},
        },
    )
    # release per-node action / event entries for nodes in this session
    s = store.get(session_id)
    if s:
        for node_id in list(s.nodes.keys()):
            store.clear_node_state(node_id)
    return {"ok": True}


@mcp.tool()
async def get_session_snapshot(session_id: str) -> dict:
    """Return current full session state (nodes, hook traces). For debugging or recovery."""
    s = store.get(session_id)
    if not s:
        return {"error": "no such session"}
    return s.model_dump()
