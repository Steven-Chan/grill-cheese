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


class Node(BaseModel):
    id: str
    parent_node_id: Optional[str] = None
    parent_branch_id: Optional[str] = None
    question: str
    reasoning: str = ""
    branches: list[Branch] = Field(default_factory=list)
    depth: int = 0
    implicit: bool = False  # decision Claude made silently, surfaced post-hoc
    created_at: float = 0.0
    # free-text answer when user picks "Other" instead of a branch
    user_note: Optional[str] = None
    # node kind: "decision" (default) or "summary" (terminal verdict card)
    kind: Optional[NodeKind] = None
    # markdown body, populated only when kind == "summary"
    summary_body: Optional[str] = None
    # picked branch (single source of truth for chosen state)
    chosen_branch_id: Optional[str] = None
    # chat-removed branches; soft delete, branch entries stay in branches[]
    removed_branch_ids: list[str] = Field(default_factory=list)
    # accumulating chat history applied to this node
    chats: list[ChatBlock] = Field(default_factory=list)
    # set when chat outcome == "redirect" — node abandoned, child carries new question
    redirected: bool = False
    # persistence: action buffer fields (moved off Store dicts so one
    # session JSON dump captures full state)
    pending_actions: list["AskBranchesResult"] = Field(default_factory=list)
    committed_actions: list["AskBranchesResult"] = Field(default_factory=list)
    is_flushed: bool = False


# ---- session ----

SessionStatus = Literal["active", "paused", "ended"]


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
    schema_version: int = 1
    started_at: float
    status: SessionStatus = "active"
    # node_id whose chat-button triggered the pause; cleared on resume
    paused_node_id: Optional[str] = None
    # branch the user pinned chat to (None = node-level chat)
    paused_branch_id: Optional[str] = None
    root_node_id: Optional[str] = None
    nodes: dict[str, Node] = Field(default_factory=dict)
    # node_id -> list of hook events attached (Read/Grep/Bash etc)
    hook_traces: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    # monotonic per-session counter incremented each _flush — emitted on
    # node_committed SSE + channel notif so the skill can detect gaps
    # (snapshot-on-wake fallback when seq jumps non-contiguously)
    next_seq: int = 0


# ---- SSE outbound events (server -> GUI) ----

class SseEvent(BaseModel):
    type: str
    session_id: str
    payload: dict[str, Any] = Field(default_factory=dict)


# ---- GUI -> server actions ----
#
# `next`           = user clicked one of the offered branches; that branch becomes
#                    chosen and the action commits so wait_for_action returns.
# `other`          = user typed free text instead of clicking a branch; `note`
#                    carries the text. Commits the action.
# `chat`           = user wants to PAUSE the grill and chat about this node
#                    in Claude Code. Bare click — no note. `branch_id` set when
#                    chat is scoped to a specific branch. Commits + server
#                    marks session paused. Skill must NOT call end_session;
#                    next present_branches on the same session auto-resumes.
# `stop`           = user is done; commits a stop action (toolbar wrap-up).
# (mark_rejected / unmark dropped — chat ops own removal now)

class GuiAction(BaseModel):
    session_id: str
    node_id: str
    branch_id: Optional[str] = None
    note: Optional[str] = None
    action: Literal[
        "next", "other", "stop", "chat",
        "stop_here", "create_plan", "implement_now", "continue_grill",
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


class AskBranchesResult(BaseModel):
    node_id: str
    chosen_branch_id: Optional[str] = None
    # Echo of the chosen branch's label so the skill never has to map the
    # server-assigned chosen_branch_id back to the option it sent. Set
    # whenever chosen_branch_id is set.
    chosen_branch_label: Optional[str] = None
    note: Optional[str] = None
    action: Literal[
        "next", "other", "stop", "chat",
        "stop_here", "create_plan", "implement_now", "continue_grill",
    ] = "next"
    # full chosen-path markdown — set only on create_plan / implement_now
    # so model can drive plan-write or coding directly off this string
    chain_markdown: Optional[str] = None


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
