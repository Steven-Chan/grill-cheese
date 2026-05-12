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
async def start_session(
    title: str,
    brief: str,
    project: str,
    kind: Optional[str] = None,
) -> dict:
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
        kind: Optional session kind. None = regular grill; "retro" = a
              retrospective session (see ADR-0005). Retros self-exclude
              from future retros' input windows. Normal grill skill should
              leave this unset.
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
    if kind is not None and kind != "retro":
        return {"error": f"kind must be None or 'retro' (got {kind!r})"}
    s = store.new_session(title, brief, project, kind=kind)
    await store.broadcast(
        s.id,
        {
            "type": "session_started",
            "session_id": s.id,
            "payload": {
                "title": title,
                "brief": brief,
                "started_at": s.started_at,
                "kind": kind,
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
    multi_select: bool = False,
    progress: Optional[float] = None,
) -> dict:
    """Push a decision node to the GUI. Returns immediately with {node_id, instruction}.

    Each branch is {label, rationale?, is_recommended?}. 2-4 branches.

    Single-mode (default): mark exactly one branch is_recommended: true.
    Multi-mode (multi_select=True): user picks a SET via checkboxes + Submit.
    Mark every branch you'd recommend (zero or more) — GUI auto-checks all
    ★ branches on render. Use multi_select for questions that genuinely
    admit multiple simultaneous picks ("which of these concerns matter?").

    `progress` (optional): best-guess fraction in [0,1] of how complete the
    session is AFTER this push lands. Re-estimate every push; downward is
    fine when the user redirects deeper (ADR-0007 honest-shrink). Absent
    hides the GUI progress bar entirely.

    After this call, your turn MUST end. The `instruction` field in the result
    spells it out — channels (notifications/claude/channel) will wake you with
    the user's action; do not poll, do not generate more text.
    """
    branch_objs = [Branch(**b) for b in branches]
    node = store.add_node(
        sid=session_id,
        question=question,
        reasoning=reasoning,
        branches=branch_objs,
        parent_node_id=parent_node_id,
        parent_branch_id=parent_branch_id,
        depth=depth,
        implicit=implicit,
        multi_select=multi_select,
        progress=progress,
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
    generate_docs: bool = False,
    docs_reason: str = "",
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
                          redirect. Result has chosen_branch_ids[0] pointing
                          to a synthetic continuation branch — pass it as
                          parent_branch_id on your next present_branches.

    `summary` is markdown. Render breathing room — multi-paragraph, bullets,
    headings welcome.

    `generate_docs` (default False) — set True if the grilled chain produced
    decisions that warrant CONTEXT.md / ADR changes. When True:
      - `implement_now` is BLOCKED (server returns 400, GUI hides the button).
        CONTEXT.md / ADR changes must be PLANNED first (create_plan).
      - Valid verdicts: stop_here / create_plan / continue_grill.
    `docs_reason` is the short reason. For ADR candidates it MUST include the
    3-criteria self-eval checklist (hard-to-reverse / surprising-without-context
    / real-tradeoff = yes/no each). Skip ADR if any answer is no. See SKILL.md
    section "Doc-awareness".

    For stop_here / create_plan / implement_now: do NOT call end_session.
    Server has already ended the session.
    """
    # Progress bar (ADR-0007): summary always pins to 100%. Claude doesn't
    # emit a progress arg here — server force-sets it for symmetry with the
    # bar's "summary = done" semantic.
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
        generate_docs=generate_docs,
        docs_reason=docs_reason or None,
        progress=1.0,
    )
    # swap wrap sentinel for real summary node id so the gate in apply_action
    # can route picks correctly. no-op if this wasn't a wrap-initiated summary.
    store.bind_wrap_summary(session_id, node.id)
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
    node.chosen_branch_ids = [branch.id]
    # add_node persisted before chosen_branch_ids was set — re-persist so the
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
async def apply_chat_result(
    session_id: str,
    node_id: str,
    chat_id: str,
    chat_summary: str,
    outcome: str,
    ops: Optional[dict] = None,
) -> dict:
    """Escape-hatch apply for a chat outcome. NOT the canonical inline-chat
    commit path — the GUI Accept button + post_chat_message proposals stage
    the canonical flow (see ADR-0001 / SKILL.md). Use this only for crash
    recovery or explicit manual override.

      - refine   : ops mutate branches (adds, removes). removes are SOFT —
                   branches stay in node.branches tagged in
                   node.removed_branch_ids and rendered greyed/struck.
      - redirect : node abandoned. node.redirected = True. Push a fresh
                   present_branches AFTER this call for the new question.

    `resolve` removed in ADR-0001 (non-blocking chat). Use `next` with an
    Own Answer if chat converged on the user's literal answer.

    `chat_id` is a UUID for idempotency: replaying the same chat_id returns
    the cached node without re-mutating.

    Returns {ok, node_id, err?, redirect_branch_id?}.
    For redirect: pass `redirect_branch_id` as `parent_branch_id` on the
    next `present_branches` so the tree stays connected.
    """
    if outcome not in ("refine", "redirect"):
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
    await store.broadcast_session_list()
    result: dict = {"ok": True, "node_id": node_id}
    if redirect_branch_id:
        result["redirect_branch_id"] = redirect_branch_id
    return result


@mcp.tool()
async def post_chat_message(
    session_id: str,
    node_id: str,
    chat_id: str,
    msg_id: str,
    text: str,
    proposals: Optional[list[dict]] = None,
) -> dict:
    """Append a Claude assistant reply to the inline chat thread on a node.

    Use this in response to a `chat_message` channel wake (user typed a
    message in the GUI). Call ONCE per assistant reply, then END YOUR TURN.

    `msg_id` is a UUID YOU generate for this message (e.g. uuid.uuid4().hex);
    idempotent on retry — same msg_id is a no-op. Use the same id if the
    transport retries.

    `proposals` (optional): stage one or more chat outcome alternatives
    inline with the reply, so the user sees the Accept picker the moment
    your message lands. Skip an extra round-trip. Each item shape:
        {"outcome": "refine" | "redirect",
         "summary": "<2-4 sentence narrative shown on Accept picker>",
         "ops": {"adds": [{label, rationale, is_recommended}],
                 "removes": ["<branch_id>", ...]}}    # refine only
    (`resolve` removed — see ADR-0001.)
    Pass a length-1 list for a single proposal; pass 2+ when you're
    offering the user alternative ways to resolve the chat (they pick ONE
    via radio + Accept). Validation is atomic across the whole batch —
    any bad item rejects the call, message NOT appended, existing
    staged set untouched. A successful call REPLACES the staged list
    (no stacking).

    Omit `proposals` when your reply is mid-thread (still gathering info).
    Include it when this reply is converging and you want the user to
    pick an outcome. Do NOT call `apply_chat_result` from the inline-chat
    flow — the inline `proposals` arg + the GUI Accept button are the
    canonical path.
    """
    # Validate proposals up front so we never half-commit. Atomic gate:
    # any bad item rejects the call before message append.
    if proposals is not None:
        verr = store.validate_proposals(session_id, node_id, proposals)
        if verr is not None:
            return {"ok": False, "err": verr}

    msg, seq, err = store.append_chat_message(
        sid=session_id,
        node_id=node_id,
        chat_id=chat_id,
        msg_id=msg_id,
        role="assistant",
        text=text,
    )
    if err is not None or msg is None:
        return {"ok": False, "err": err or "append failed"}
    # broadcast only on fresh append (idempotent replay returns seq=None)
    if seq is not None:
        await store.broadcast(
            session_id,
            {
                "type": "chat_message_added",
                "session_id": session_id,
                "payload": {
                    "node_id": node_id,
                    "chat_id": chat_id,
                    "message": msg.model_dump(),
                    "seq": seq,
                },
            },
        )

    result: dict = {"ok": True, "msg_id": msg.msg_id}

    # Gate staging on a fresh append (seq is not None). On idempotent
    # replay the original call already staged these proposals — re-staging
    # would clobber any newer set that landed between the original
    # response loss and the retry.
    if proposals is not None and seq is not None:
        staged, perr = store.set_pending_proposals(
            sid=session_id,
            node_id=node_id,
            chat_id=chat_id,
            proposals=proposals,
        )
        # message already landed; surface stage failure without rolling back
        if perr is not None or staged is None:
            result["proposal_err"] = perr or "stage failed"
        else:
            await store.broadcast(
                session_id,
                {
                    "type": "chat_proposals_staged",
                    "session_id": session_id,
                    "payload": {
                        "node_id": node_id,
                        "proposals": [p.model_dump() for p in staged],
                    },
                },
            )
            result["proposal_ids"] = [p.proposal_id for p in staged]
            result["proposed_at"] = staged[0].proposed_at

    return result


@mcp.tool()
async def end_session(session_id: str, summary: str = "") -> dict:
    """End the grill session. Final summary is broadcast to GUI."""
    s = store.get(session_id)
    if s:
        # Perf log entry — only on the active→ended transition (no double
        # emit on idempotent re-call). verdict="end_session" marks this as
        # the explicit-bailout path (vs the verdict-driven auto-end in hooks).
        if s.status != "ended":
            store.emit_performance_entry(session_id, verdict="end_session")
            # ADR-0005: retro sessions advance the marker on end_session too
            # (covers the empty-window early-exit path where the skill calls
            # end_session immediately).
            if s.kind == "retro":
                try:
                    from . import retro as retro_mod
                    retro_mod.write_marker(s.project)
                except Exception:
                    pass
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


@mcp.tool()
async def get_retro_input(project: str, repo_root: str) -> dict:
    """Return the structured input payload the retro skill reads to compose
    its own brief (ADR-0005 Revisions, 2026-05-12).

    Scans ended sessions for `project` since the retro marker timestamp at
    `~/.grill-cheese/project-<slug>/.last-retro`, collects disagreed
    decision nodes (recommendation_score < 1) plus their chat transcripts
    and own_answer text, and reads current doc state (CLAUDE.md / ADRs /
    CONTEXT.md / skill files / global ~/.claude/CLAUDE.md).

    Returns the raw payload — no session started, no markdown rendered.
    The skill takes this, composes a slim user-facing brief, then calls
    regular `start_session(title, brief, project, kind="retro")`.

    Returns:
        {project, since, is_empty, session_count, disagreed: [...],
         doc_state: {<path>: <body>, ...}}.
        When is_empty=true the skill should tell the user there's nothing
        to retro and NOT call start_session.

    Args:
        project: project slug (same as start_session.project).
        repo_root: absolute path to the project repo (skill should pass
                   `git rev-parse --show-toplevel`). Used to read in-repo
                   CLAUDE.md / docs/adr/* / CONTEXT.md / skill/*/SKILL.md.
    """
    from pathlib import Path
    from . import retro as retro_mod

    if not project or not project.strip():
        return {"error": "project must be a non-empty string"}
    project = project.strip()
    if not repo_root or not repo_root.strip():
        return {"error": "repo_root must be a non-empty string"}
    root = Path(repo_root.strip()).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        return {"error": f"repo_root does not exist or is not a directory: {root}"}

    payload = retro_mod.assemble_full_payload(project, root)
    return payload.model_dump()
