"""Pydantic schemas for grill-cheese events + state."""
from __future__ import annotations

import uuid
from typing import Any, Literal, Optional
from pydantic import BaseModel, Field


# ---- branch + node ----

BranchState = Literal["considered", "rejected", "chosen"]


def _bid() -> str:
    return uuid.uuid4().hex[:8]


class Branch(BaseModel):
    id: str = Field(default_factory=_bid)
    label: str
    rationale: str = ""
    is_recommended: bool = False
    state: BranchState = "considered"
    child_node_id: Optional[str] = None


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


# ---- session ----

SessionStatus = Literal["active", "paused", "ended"]


class Session(BaseModel):
    id: str
    brief: str
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
# `mark_rejected` /`unmark` = side-tagging branches without committing.
# `stop`           = user is done; commits a stop action.

class GuiAction(BaseModel):
    session_id: str
    node_id: str
    branch_id: Optional[str] = None
    note: Optional[str] = None
    action: Literal["next", "other", "mark_rejected", "stop", "unmark", "chat"]


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
        "next", "other", "stop", "chat", "mark_rejected", "unmark"
    ] = "next"


class WaitForActionResult(BaseModel):
    """Batched return for wait_for_action.

    Empty `actions` = skip (transport timeout, no flush yet — re-poll).
    Non-empty = flushed batch; idempotent on subsequent polls.
    """
    node_id: str
    actions: list[AskBranchesResult] = Field(default_factory=list)


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
