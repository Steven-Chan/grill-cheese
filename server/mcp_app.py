"""MCP tools exposed to Claude Code."""
from __future__ import annotations

import time
from typing import Optional

from mcp.server.fastmcp import FastMCP

from .schemas import (
    AskBranchesResult,
    Branch,
    ChatOps,
)
from .state import store
from .telemetry import forget_session, log_push

TITLE_MAX = 80

# Instruction string returned from present_branches / present_summary so the
# skill (and Claude) gets a fresh, in-tool reminder to end the turn instead
# of polling. Channels deliver the user's action; no waiting needed here.
END_TURN_INSTRUCTION = (
    "TURN_OVER. Stop generating. Do NOT call any other tool. Do NOT "
    "write more text. The grill-cheese channel will wake you when the "
    "user clicks; on wake, parse the <channel source=\"grill-cheese\" ...> "
    "block and act on its actions."
)


mcp = FastMCP("grill-cheese", json_response=True, streamable_http_path="/")


@mcp.tool()
async def start_session(title: str, brief: str, project: str) -> dict:
    """Start a new grill session. Call once at the very start.

    Args:
        title: Short headline for the session — imperative noun phrase,
               project-style (e.g. "Add billing system", "Refactor SSE pubsub").
               Required, ≤80 chars. Shown in the toolbar + session picker.
        brief: The user's plan / proposal / question to be grilled. Full text;
               rendered as markdown in the collapsible brief banner.
        project: Repo / directory slug for on-disk session path partitioning.
                 Skill should pass `git rev-parse --show-toplevel | xargs basename`
                 (or cwd basename as fallback). Required.
    Returns:
        {session_id, started_at}
    """
    if not project or not project.strip():
        return {"error": "project must be a non-empty string"}
    project = project.strip()
    if not title or not title.strip():
        return {"error": "title must be a non-empty string"}
    title = title.strip()
    if len(title) > TITLE_MAX:
        return {"error": f"title must be ≤{TITLE_MAX} chars (got {len(title)})"}
    s = store.new_session(title, brief, project)
    await store.broadcast(
        s.id,
        {
            "type": "session_started",
            "session_id": s.id,
            "payload": {
                "title": title,
                "brief": brief,
                "started_at": s.started_at,
            },
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
    """Push a decision node to the GUI. Returns immediately with {node_id, instruction}.

    Each branch is {label, rationale?, is_recommended?}. 2-4 branches.
    Mark exactly one branch is_recommended: true.

    After this call, your turn MUST end. The `instruction` field in the result
    spells it out — channels (notifications/claude/channel) will wake you with
    the user's action; do not poll, do not generate more text.
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
    log_push(session_id, node.id, "present_branches")
    return {"node_id": node.id, "instruction": END_TURN_INSTRUCTION}


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
    """Push a SUMMARY node (verdict card) to the GUI. Returns {node_id, instruction}.

    Symmetric to present_branches: returns instantly; channels deliver the user's
    verdict action via notifications/claude/channel. The user picks one of four
    verdict actions:

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
    log_push(session_id, node.id, "present_summary")
    return {"node_id": node.id, "instruction": END_TURN_INSTRUCTION}


# NOTE: wait_for_action removed — channels (notifications/claude/channel)
# now deliver flushed action batches by waking Claude with a <channel> block.
# See server/shim.py for the stdio bridge that emits them. ask_branches was
# also removed earlier — single-call wrappers around push+wait re-create the
# duplicate-node bug on transport retries.


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
    No further actions on it via channel either. After resume, push a NEW
    `present_branches` to keep grilling, or call `end_session` if done.

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
    forget_session(session_id)
    await store.broadcast_session_list()
    return {"ok": True}


@mcp.tool()
async def get_session_snapshot(session_id: str) -> dict:
    """Return current full session state (nodes, hook traces). For debugging or recovery."""
    s = store.get(session_id)
    if not s:
        return {"error": "no such session"}
    return s.model_dump()
