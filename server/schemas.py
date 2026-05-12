"""Pydantic schemas for grill-cheese events + state."""
from __future__ import annotations

import uuid
from typing import Any, Literal, Optional
from pydantic import BaseModel, Field, field_validator


# ---- branch + node ----


def _bid() -> str:
    return uuid.uuid4().hex[:8]


class Branch(BaseModel):
    id: str = Field(default_factory=_bid)
    label: str
    rationale: str = ""
    is_recommended: bool = False
    # synthesized from typed-text submit (action=next + note). GUI tags it.
    user_authored: bool = False
    child_node_id: Optional[str] = None


NodeKind = Literal["decision", "summary"]
# `resolve` outcome dropped — see docs/adr/0001-non-blocking-chat.md.
# Legacy session JSONs with outcome="resolve" rehydrate via extra="ignore".
ChatOutcome = Literal["refine", "redirect"]


class ChatBlock(BaseModel):
    """One applied chat result on a node. Accumulates in Node.chats."""
    model_config = {"extra": "ignore"}

    chat_id: str
    summary: str
    outcome: ChatOutcome
    applied_at: float


class ChatOps(BaseModel):
    """Branch ops applied on refine. removes -> ids; adds -> new branches."""
    adds: list[Branch] = Field(default_factory=list)
    removes: list[str] = Field(default_factory=list)


# inline-chat: live transcript message (user or Claude). Cleared on
# Accept/Close — see Node.chat_messages.
class ChatMessage(BaseModel):
    msg_id: str
    role: Literal["user", "assistant"]
    text: str
    ts: float


# inline-chat: staged proposal from Claude. Multiple may be staged at once
# (Claude offers a set of alternative outcomes); user picks ONE via
# proposal_id to accept. Whole list is replaced when Claude emits a fresh
# post_chat_message(proposals=[...]) (no stacking). Cleared on Accept/Close.
class PendingProposal(BaseModel):
    proposal_id: str = Field(default_factory=_bid)
    chat_id: str
    outcome: ChatOutcome
    ops: Optional[ChatOps] = None  # refine only
    summary: str
    proposed_at: float


class Node(BaseModel):
    # extra=ignore so old session JSONs missing dropped fields (user_note,
    # chosen_branch_id) load without crashing during rehydrate.
    model_config = {"extra": "ignore"}

    id: str
    parent_node_id: Optional[str] = None
    parent_branch_id: Optional[str] = None
    question: str
    reasoning: str = ""
    branches: list[Branch] = Field(default_factory=list)
    depth: int = 0
    implicit: bool = False  # decision Claude made silently, surfaced post-hoc
    created_at: float = 0.0
    # render mode: false=radio (single pick), true=checkboxes (set pick)
    multi_select: bool = False
    # node kind: "decision" (default) or "summary" (terminal verdict card)
    kind: Optional[NodeKind] = None
    # markdown body, populated only when kind == "summary"
    summary_body: Optional[str] = None
    # doc-awareness flag, summary-only. When true: implement_now is blocked
    # (server enforces, GUI hides) — CONTEXT.md/ADR changes must be planned
    # first. create_plan / stop_here / continue_grill remain valid.
    generate_docs: bool = False
    # short reason Claude provides alongside generate_docs=True. For ADR
    # candidates this MUST include the 3-criteria self-eval checklist
    # (hard-to-reverse / surprising / real-tradeoff) — see SKILL.md.
    docs_reason: Optional[str] = None
    # picked branches (plural-only — radio = list of length 1; multi = set).
    # Synth user_authored branches from typed text are appended to .branches
    # AND included here on the same submit.
    chosen_branch_ids: list[str] = Field(default_factory=list)
    # chat-removed branches; soft delete, branch entries stay in branches[]
    removed_branch_ids: list[str] = Field(default_factory=list)
    # pick-rate score in [0, 1] or None. Single-mode: 1 if user picked the ★
    # branch, else 0 (Own Answer / chat redirect → 0). Multi-mode:
    # picked_recs / total_recs. None for summary, implicit, and multi-mode
    # with zero recommendations. Computed once at `next` commit in _flush;
    # never recomputed. See CONTEXT.md + ADR-0003.
    recommendation_score: Optional[float] = None
    # accumulating chat history applied to this node
    chats: list[ChatBlock] = Field(default_factory=list)
    # set when chat outcome == "redirect" — node abandoned, child carries new question
    redirected: bool = False
    # inline-chat: live transcript. Persisted across reloads. Composer is
    # always-visible (non-blocking chat — see ADR-0001); empty list means
    # no chat thread started on this node yet. Pruned on Accept (lands as
    # ChatBlock) or Close (discard, nothing applied).
    chat_messages: list[ChatMessage] = Field(default_factory=list)
    # inline-chat: staged proposals from Claude. Multi-slot — Claude can
    # offer N alternatives in one `post_chat_message(proposals=[...])`
    # call; the whole list is replaced atomically on a fresh stage (no
    # stacking). User picks ONE via proposal_id to commit. Empty list
    # when no proposals are staged or after Accept/Close.
    pending_proposals: list[PendingProposal] = Field(default_factory=list)
    # persistence: action buffer fields (moved off Store dicts so one
    # session JSON dump captures full state)
    pending_actions: list["AskBranchesResult"] = Field(default_factory=list)
    committed_actions: list["AskBranchesResult"] = Field(default_factory=list)
    is_flushed: bool = False


# ---- session ----

# `paused` removed — non-blocking chat (ADR-0001). Legacy JSONs with
# status="paused" rehydrate via extra="ignore" and fall back to "active".
SessionStatus = Literal["active", "ended"]

# kind="retro" sessions are nested grill-cheese sessions whose brief is
# composed from disagreement data of prior ended sessions for the same
# project. Self-exclude from future retros' windows. See ADR-0005.
SessionKind = Literal["retro"]


class CmuxInfo(BaseModel):
    """Terminal-multiplexer coords captured at session start so the GUI can
    deep-link back to the cmux pane that hosts this CC session. Stamped post-
    `start_session` from an X-Grill-Cmux header on the shim's HTTP client.
    All fields optional — partial capture is still useful (workspace-only
    jump is a valid fallback when panel_id is missing)."""
    workspace_id: Optional[str] = None
    panel_id: Optional[str] = None
    socket_path: Optional[str] = None
    bin_path: Optional[str] = None


class Session(BaseModel):
    model_config = {"extra": "ignore"}

    @field_validator("status", mode="before")
    @classmethod
    def _coerce_legacy_paused(cls, v):
        # Legacy session JSONs (pre-ADR-0001) carry status="paused". The
        # literal no longer accepts it; without this remap the whole
        # session would fail rehydration and get quarantined as .json.bad.
        if v == "paused":
            return "active"
        return v

    id: str
    title: Optional[str] = None
    brief: str
    project: str = ""
    # uuid of the shim that owns this session. SSE/channel events for this
    # session are only delivered to subscribers matching this owner — keeps
    # parallel CC instances from cross-talking.
    owner_id: Optional[str] = None
    # cmux deep-link coords (None if CC was not launched inside cmux).
    cmux: Optional[CmuxInfo] = None
    schema_version: int = 1
    started_at: float
    status: SessionStatus = "active"
    # None = regular grill; "retro" = retrospective session (ADR-0005).
    # Retros self-exclude from future retros' input windows.
    kind: Optional[SessionKind] = None
    # set when the toolbar Wrap-up endpoint fires. Sentinel
    # `__wrap_pending__` until present_summary lands; then the real summary
    # node id. Drives the apply_action gate that locks the pre-wrap pending
    # node. Cleared on continue_grill verdict (session resumes normal).
    wrap_summary_node_id: Optional[str] = None
    root_node_id: Optional[str] = None
    nodes: dict[str, Node] = Field(default_factory=dict)
    # node_id -> list of hook events attached (Read/Grep/Bash etc)
    hook_traces: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    # monotonic per-session counter incremented each _flush — emitted on
    # node_committed SSE + channel notif so the skill can detect gaps
    # (snapshot-on-wake fallback when seq jumps non-contiguously)
    next_seq: int = 0


# ---- SSE outbound events (server -> GUI) ----
# Event types: session_started, session_list, session_ended, session_deleted,
# session_wrap, node_added, node_updated, node_committed, chat_message_added,
# chat_proposals_staged, chat_accepted, chat_closed, hook_event, session_meta.
# session_wrap fires when the toolbar Wrap-up endpoint is hit; payload is
# empty {} (session id carries the context). chat_accepted fires after the
# GUI Accept commits a staged chat proposal — shim bridges it to channel
# so Claude wakes and pushes the next present_branches (no more dead-end).
# (session_paused / session_resumed removed — see ADR-0001.)

class SseEvent(BaseModel):
    type: str
    session_id: str
    payload: dict[str, Any] = Field(default_factory=dict)


# ---- GUI -> server actions ----
#
# `next`           = user submitted picks. `branch_ids` carries the chosen
#                    set (length 1 in radio/single-mode, ≥1 in multi-mode).
#                    `own_answer` carries optional typed text — server
#                    synthesizes a user_authored Branch from it and appends
#                    to the submission. Min=1: must have ≥1 branch_id OR
#                    non-empty own_answer.
# Verdict actions: stop_here / create_plan / implement_now / continue_grill
# (summary nodes only).
# Inline-chat actions: chat_user_msg / chat_accept / chat_close.
# (`chat` action removed — composer is always-visible, no open-event needed.
# See ADR-0001.)

class GuiAction(BaseModel):
    model_config = {"extra": "ignore"}

    session_id: str
    node_id: str
    # plural pick set for action=next. May be empty when only own_answer is
    # set (typed text → synth branch). Server rejects next with both empty.
    branch_ids: list[str] = Field(default_factory=list)
    # Own Answer text — first-class commit input for action=next when no
    # Claude-proposed branch fits. Server synthesizes a user_authored Branch
    # from it. NOT a note attached to a branch pick. See CONTEXT.md.
    own_answer: Optional[str] = None
    # inline-chat: chat thread id, set on action ∈ {chat_user_msg,
    # chat_accept, chat_close}. Generated GUI-side on first user msg.
    chat_id: Optional[str] = None
    # inline-chat: per-message uuid for idempotent append. action=chat_user_msg.
    msg_id: Optional[str] = None
    # inline-chat: user-typed text for action=chat_user_msg.
    text: Optional[str] = None
    # inline-chat: which staged proposal the user accepted. Required on
    # action=chat_accept now that multiple proposals can be staged at once.
    proposal_id: Optional[str] = None
    action: Literal[
        "next",
        "stop_here", "create_plan", "implement_now", "continue_grill",
        "chat_user_msg", "chat_accept", "chat_close",
    ]


# ---- present_branches / wait_for_action MCP tool input/output ----

class AskBranchesInput(BaseModel):
    session_id: str
    parent_node_id: Optional[str] = None
    parent_branch_id: Optional[str] = None
    question: str
    reasoning: str = ""
    branches: list[Branch]
    depth: int = 0
    implicit: bool = False
    # render mode: false=radio (single pick), true=checkboxes. Multi-★ is
    # allowed; GUI auto-checks all ★ on render.
    multi_select: bool = False


class AskBranchesResult(BaseModel):
    model_config = {"extra": "ignore"}

    node_id: str
    # plural-only chosen state. Length 1 for radio, ≥1 for multi. Includes
    # synth user_authored branches when typed text accompanied the submit.
    chosen_branch_ids: list[str] = Field(default_factory=list)
    # Label echo so the skill never has to map ids back to its options.
    # Same length + order as chosen_branch_ids.
    chosen_branch_labels: list[str] = Field(default_factory=list)
    # Own Answer text (when user typed an answer instead of / alongside picks).
    own_answer: Optional[str] = None
    action: Literal[
        "next",
        "stop_here", "create_plan", "implement_now", "continue_grill",
    ] = "next"
    # full chosen-path markdown — set only on create_plan / implement_now
    # so model can drive plan-write or coding directly off this string
    chain_markdown: Optional[str] = None


# ---- performance log (separate-entity, append-only) ----
# One entry per ended session at ~/.grill-cheese/performance.jsonl. The log
# is decoupled from session JSONs because sessions get pruned; perf history
# must outlive them. See ADR-0003.

PerfVerdict = Literal["stop_here", "create_plan", "implement_now", "end_session"]


class PerformanceEntry(BaseModel):
    model_config = {"extra": "ignore"}

    session_id: str
    project: str
    title: Optional[str] = None
    ended_at: float
    # session-level mean of decision scores, nulls skipped. None when the
    # session had zero scored decisions (only summary / implicit / 0-rec multi).
    score: Optional[float] = None
    # number of decisions that contributed to score (excludes nulls).
    decision_count: int = 0
    verdict: PerfVerdict


# ---- claude code hook payload (subset we care about) ----

class HookEvent(BaseModel):
    session_id: str = ""
    hook_event_name: str = ""
    tool_name: str = ""
    tool_input: dict[str, Any] = Field(default_factory=dict)
    tool_response: dict[str, Any] = Field(default_factory=dict)
    timestamp: float = 0.0
    # link to grill node if Claude annotated it via env var GRILL_CHEESE_NODE_ID
    grill_node_id: Optional[str] = None
    grill_session_id: Optional[str] = None
