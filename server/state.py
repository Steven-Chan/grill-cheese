"""Session store + pending-request map for the present_branches / wait_for_action loop."""
from __future__ import annotations

import asyncio
import time
import uuid
from collections import defaultdict, deque
from typing import Any, Optional

from .schemas import (
    AskBranchesResult,
    Branch,
    GuiAction,
    HookEvent,
    Node,
    Session,
)

MAX_RING = 5000  # per-session SSE replay buffer


class Store:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self.ring: dict[str, deque[dict[str, Any]]] = defaultdict(
            lambda: deque(maxlen=MAX_RING)
        )
        # node_id -> committed action (idempotent: once set, wait_for_action returns it)
        self._actions: dict[str, AskBranchesResult] = {}
        # node_id -> Event signalling action arrival (lazy-created in get_event)
        self._events: dict[str, asyncio.Event] = {}
        # SSE subscribers: session_id -> list[asyncio.Queue]
        self._subs: dict[str, list[asyncio.Queue[dict[str, Any]]]] = defaultdict(list)
        # global subscribers (all sessions, for index page)
        self._global_subs: list[asyncio.Queue[dict[str, Any]]] = []
        self._lock = asyncio.Lock()

    # ---- sessions ----
    def new_session(self, brief: str) -> Session:
        sid = uuid.uuid4().hex[:12]
        s = Session(id=sid, brief=brief, started_at=time.time())
        self.sessions[sid] = s
        return s

    def get(self, sid: str) -> Optional[Session]:
        return self.sessions.get(sid)

    # ---- nodes ----
    def add_node(
        self,
        sid: str,
        question: str,
        reasoning: str,
        branches: list[Branch],
        parent_node_id: Optional[str],
        parent_branch_id: Optional[str],
        depth: int,
        implicit: bool = False,
    ) -> Node:
        s = self.sessions[sid]
        node_id = uuid.uuid4().hex[:10]
        for b in branches:
            if not b.id:
                b.id = uuid.uuid4().hex[:8]
        node = Node(
            id=node_id,
            parent_node_id=parent_node_id,
            parent_branch_id=parent_branch_id,
            question=question,
            reasoning=reasoning,
            branches=branches,
            depth=depth,
            implicit=implicit,
            created_at=time.time(),
        )
        s.nodes[node_id] = node
        if s.root_node_id is None:
            s.root_node_id = node_id
        # link parent branch -> this node
        if parent_node_id and parent_branch_id:
            parent = s.nodes.get(parent_node_id)
            if parent:
                for b in parent.branches:
                    if b.id == parent_branch_id:
                        b.child_node_id = node_id
                        break
        return node

    # ---- per-node action store (long-poll friendly) ----
    def get_event(self, node_id: str) -> asyncio.Event:
        ev = self._events.get(node_id)
        if ev is None:
            ev = asyncio.Event()
            self._events[node_id] = ev
        return ev

    def get_action(self, node_id: str) -> Optional[AskBranchesResult]:
        return self._actions.get(node_id)

    def set_action(self, node_id: str, result: AskBranchesResult) -> bool:
        """Idempotent commit. First write wins; returns True if newly committed."""
        if node_id in self._actions:
            return False
        self._actions[node_id] = result
        self.get_event(node_id).set()
        return True

    def clear_node_state(self, node_id: str) -> None:
        """End-of-session cleanup."""
        self._actions.pop(node_id, None)
        self._events.pop(node_id, None)

    def pause_session(
        self, sid: str, node_id: str, branch_id: Optional[str] = None
    ) -> Optional[Session]:
        """Mark session paused (chat handoff to CC). Returns session or None."""
        s = self.sessions.get(sid)
        if not s:
            return None
        s.status = "paused"
        s.paused_node_id = node_id
        s.paused_branch_id = branch_id
        return s

    def resume_session(self, sid: str) -> Optional[Session]:
        """Flip paused → active. Called when present_branches pushes after pause."""
        s = self.sessions.get(sid)
        if not s or s.status != "paused":
            return None
        s.status = "active"
        s.paused_node_id = None
        s.paused_branch_id = None
        return s

    # ---- branch state mutation from GUI ----
    def apply_action(self, action: GuiAction) -> Optional[AskBranchesResult]:
        """Validate + (when committing) mutate.

        Returns None for tagging-only actions or invalid input. Returns an
        AskBranchesResult for actions that should wake `wait_for_action`.

        Mutations on the node (branch state, user_note) only apply when this
        is also a fresh first-write commit — caller must call `set_action`
        and, only if it returns True, then call `apply_committed` to persist
        node mutations before broadcasting `node_updated`.
        """
        s = self.sessions.get(action.session_id)
        if not s:
            return None
        node = s.nodes.get(action.node_id)
        if not node:
            return None

        if action.action == "stop":
            return AskBranchesResult(node_id=action.node_id, action="stop")

        # tagging-only actions (no commit, no wait_for_action wakeup)
        if action.action in ("mark_rejected", "unmark") and action.branch_id:
            for b in node.branches:
                if b.id == action.branch_id:
                    if action.action == "mark_rejected":
                        b.state = "rejected"
                    else:  # unmark
                        b.state = "considered"
                    break
            return None

        if action.action == "next":
            if not action.branch_id:
                return None
            # validate branch exists; do NOT mutate yet (caller commits first)
            chosen = next(
                (b for b in node.branches if b.id == action.branch_id), None
            )
            if chosen is None:
                return None
            return AskBranchesResult(
                node_id=action.node_id,
                chosen_branch_id=chosen.id,
                chosen_branch_label=chosen.label,
                note=action.note,
                action="next",
            )

        if action.action == "other":
            if not action.note:
                return None
            return AskBranchesResult(
                node_id=action.node_id,
                note=action.note,
                action="other",
            )

        if action.action == "chat":
            # bare click. branch_id optional: when set, chat is scoped to a
            # specific branch and surfaces in chosen_branch_id (+ label) so
            # the skill knows the scope without ID-to-label mapping.
            chosen = None
            if action.branch_id:
                chosen = next(
                    (b for b in node.branches if b.id == action.branch_id), None
                )
                if chosen is None:
                    return None
            return AskBranchesResult(
                node_id=action.node_id,
                chosen_branch_id=chosen.id if chosen else None,
                chosen_branch_label=chosen.label if chosen else None,
                action="chat",
            )
        return None

    def apply_committed(self, action: GuiAction) -> None:
        """Apply node mutations that should only happen on a *fresh* commit.

        Caller invokes this AFTER `set_action` has returned True so that a
        late/duplicate click does not corrupt visible node state.
        """
        s = self.sessions.get(action.session_id)
        if not s:
            return
        node = s.nodes.get(action.node_id)
        if not node:
            return
        if action.action == "next" and action.branch_id:
            for b in node.branches:
                if b.id == action.branch_id:
                    for other in node.branches:
                        if other.state == "chosen" and other.id != b.id:
                            other.state = "considered"
                    b.state = "chosen"
                    break
        elif action.action == "other" and action.note:
            node.user_note = action.note
        # chat: bare click, no seed → no node mutation

    # ---- hook traces ----
    def attach_hook(self, ev: HookEvent) -> None:
        sid = ev.grill_session_id or ev.session_id
        if not sid or sid not in self.sessions:
            return
        s = self.sessions[sid]
        node_id = ev.grill_node_id or "_unbound"
        s.hook_traces.setdefault(node_id, []).append(ev.model_dump())

    # ---- SSE pub/sub ----
    async def subscribe(
        self, sid: Optional[str]
    ) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=512)
        async with self._lock:
            if sid:
                self._subs[sid].append(q)
                # replay ring
                for ev in list(self.ring[sid]):
                    await q.put(ev)
            else:
                self._global_subs.append(q)
                # send session list snapshot
                await q.put(
                    {
                        "type": "session_list",
                        "session_id": "",
                        "payload": {
                            "sessions": [
                                {
                                    "id": s.id,
                                    "brief": s.brief,
                                    "started_at": s.started_at,
                                }
                                for s in self.sessions.values()
                            ]
                        },
                    }
                )
        return q

    async def unsubscribe(
        self, sid: Optional[str], q: asyncio.Queue[dict[str, Any]]
    ) -> None:
        async with self._lock:
            if sid and q in self._subs.get(sid, []):
                self._subs[sid].remove(q)
            elif q in self._global_subs:
                self._global_subs.remove(q)

    async def broadcast(self, sid: str, ev: dict[str, Any]) -> None:
        self.ring[sid].append(ev)
        async with self._lock:
            targets = list(self._subs.get(sid, [])) + list(self._global_subs)
        for q in targets:
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                pass


store = Store()
