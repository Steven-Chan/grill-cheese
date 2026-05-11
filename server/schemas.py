"""Pydantic schemas for grill-cheese events + state."""
from __future__ import annotations

import uuid
from typing import Any, Literal, Optional
from pydantic import BaseModel, Field


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
ChatOutcome = Literal["refine", "redirect", "resolve"]


class ChatBlock(BaseModel):
    """One applied chat result on a node. Accumulates in Node.chats."""
    chat_id: str
    summary: str
    outcome: ChatOutcome
    applied_at: float
    branch_id: Optional[str] = None  # set when chat was scoped to a branch


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


# inline-chat: latest staged proposal from Claude. Overwritten when Claude
# emits a fresh propose_chat_outcome (no stacking). Cleared on Accept/Close.
class PendingProposal(BaseModel):
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
    # accumulating chat history applied to this node
    chats: list[ChatBlock] = Field(default_factory=list)
    # set when chat outcome == "redirect" — node abandoned, child carries new question
    redirected: bool = False
    # inline-chat: live transcript. Persisted between Open and Accept/Close
    # so refresh/restart preserves the thread. Pruned on Accept (apply lands
    # as ChatBlock) or Close (discard, nothing applied).
    chat_messages: list[ChatMessage] = Field(default_factory=list)
    # inline-chat: latest staged proposal from Claude. Single-slot — fresh
    # propose_chat_outcome overwrites. None when chat is open with no
    # proposal yet, or after Accept/Close.
    pending_proposal: Optional[PendingProposal] = None
    # inline-chat: true between user clicking Chat and Accept/Close.
    # Survives reload so the panel re-renders open.
    chat_open: bool = False
    # persistence: action buffer fields (moved off Store dicts so one
    # session JSON dump captures full state)
    pending_actions: list["AskBranchesResult"] = Field(default_factory=list)
    committed_actions: list["AskBranchesResult"] = Field(default_factory=list)
    is_flushed: bool = False


# ---- session ----

SessionStatus = Literal["active", "paused", "ended"]


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
    # node_id whose chat-button triggered the pause; cleared on resume
    paused_node_id: Optional[str] = None
    # branch the user pinned chat to (None = node-level chat)
    paused_branch_id: Optional[str] = None
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
# session_paused, session_resumed, session_wrap, node_added, node_updated,
# node_committed, chat_message_added, chat_accepted, chat_closed, hook_event.
# session_wrap fires when the toolbar Wrap-up endpoint is hit; payload is
# empty {} (session id carries the context). chat_accepted fires after the
# GUI Accept commits a staged chat proposal — shim bridges it to channel
# so Claude wakes and pushes the next present_branches (no more dead-end).

class SseEvent(BaseModel):
    type: str
    session_id: str
    payload: dict[str, Any] = Field(default_factory=dict)


# ---- GUI -> server actions ----
#
# `next`           = user submitted picks. `branch_ids` carries the chosen
#                    set (length 1 in radio/single-mode, ≥1 in multi-mode).
#                    `note` carries optional typed text — server synthesizes
#                    a user_authored Branch from it and appends to the
#                    submission. Min=1: must have ≥1 branch_id OR non-empty
#                    note. (action=other was killed; typed text now goes
#                    through next + note.)
# `chat`           = user wants to PAUSE the grill and chat about this node
#                    in Claude Code. Bare click — no note. `branch_id` set
#                    when chat is scoped to a specific branch (single id,
#                    not a set: chat is per-row). Commits + server marks
#                    session paused.
# `stop`           = user is done; commits a stop action (toolbar wrap-up).
# (mark_rejected / unmark dropped — chat ops own removal now)

class GuiAction(BaseModel):
    session_id: str
    node_id: str
    # plural pick set for action=next. May be empty when only `note` is set
    # (typed text → synth branch). Server rejects next with both empty.
    branch_ids: list[str] = Field(default_factory=list)
    # single-id scope for action=chat (chat-on-row). Unused by next.
    branch_id: Optional[str] = None
    note: Optional[str] = None
    # inline-chat: chat thread id, set on action ∈ {chat_user_msg,
    # chat_accept, chat_close}. Generated GUI-side on first user msg.
    chat_id: Optional[str] = None
    # inline-chat: per-message uuid for idempotent append. action=chat_user_msg.
    msg_id: Optional[str] = None
    # inline-chat: user-typed text for action=chat_user_msg.
    text: Optional[str] = None
    action: Literal[
        "next", "chat",
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
    node_id: str
    # plural-only chosen state. Length 1 for radio, ≥1 for multi. Includes
    # synth user_authored branches when typed text accompanied the submit.
    chosen_branch_ids: list[str] = Field(default_factory=list)
    # Label echo so the skill never has to map ids back to its options.
    # Same length + order as chosen_branch_ids.
    chosen_branch_labels: list[str] = Field(default_factory=list)
    note: Optional[str] = None
    action: Literal[
        "next", "chat",
        "stop_here", "create_plan", "implement_now", "continue_grill",
    ] = "next"
    # full chosen-path markdown — set only on create_plan / implement_now
    # so model can drive plan-write or coding directly off this string
    chain_markdown: Optional[str] = None
    # chat-only scope (per-row chat). Distinct field from chosen_* to keep
    # the discriminated-union honest: chat result is never a "pick".
    chat_branch_id: Optional[str] = None
    chat_branch_label: Optional[str] = None


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
    # set true server-side when hook arrives while session is paused on this node
    chat_tag: bool = False
