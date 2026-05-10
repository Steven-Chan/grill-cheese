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
DEBOUNCE_SECONDS = 0.75  # idle window before flushing buffered clicks
TERMINAL_ACTIONS = {"next", "other", "stop", "chat"}


class Store:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self.ring: dict[str, deque[dict[str, Any]]] = defaultdict(
            lambda: deque(maxlen=MAX_RING)
        )
        # node_id -> committed batch of actions (idempotent: once set,
        # wait_for_action returns the same list)
        self._actions: dict[str, list[AskBranchesResult]] = {}
        # node_id -> in-progress buffer (filled by enqueue_action, drained on flush)
        self._pending: dict[str, list[AskBranchesResult]] = {}
        # node_id -> debounce timer handle (asyncio.TimerHandle from call_later)
        self._timers: dict[str, Any] = {}
        # node_ids whose buffer has been flushed → locked, reject further clicks
        self._flushed: set[str] = set()
        # node_id -> Event signalling buffer flushed (lazy-created in get_event)
        self._events: dict[str, asyncio.Event] = {}
        # session_id -> Event signalling status change (pause/resume)
        self._status_events: dict[str, asyncio.Event] = {}
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

    # ---- per-node action buffer (idle-debounce flush) ----
    def get_event(self, node_id: str) -> asyncio.Event:
        ev = self._events.get(node_id)
        if ev is None:
            ev = asyncio.Event()
            self._events[node_id] = ev
        return ev

    def get_actions(self, node_id: str) -> Optional[list[AskBranchesResult]]:
        """Return committed batch, or None if not yet flushed."""
        return self._actions.get(node_id)

    def is_flushed(self, node_id: str) -> bool:
        return node_id in self._flushed

    def enqueue_action(
        self, session_id: str, node_id: str, record: AskBranchesResult
    ) -> bool:
        """Append record to pending buffer + reset 750ms idle timer.
        Returns False if node already locked (caller should reject)."""
        if node_id in self._flushed:
            return False
        self._pending.setdefault(node_id, []).append(record)
        existing = self._timers.pop(node_id, None)
        if existing is not None:
            existing.cancel()
        loop = asyncio.get_event_loop()
        self._timers[node_id] = loop.call_later(
            DEBOUNCE_SECONDS, self._flush, session_id, node_id
        )
        return True

    def flush_now(self, session_id: str, node_id: str) -> None:
        """Bypass idle timer — used by terminal-class clicks (next/other/stop/chat)."""
        existing = self._timers.pop(node_id, None)
        if existing is not None:
            existing.cancel()
        self._flush(session_id, node_id)

    def _flush(self, session_id: str, node_id: str) -> None:
        """Move pending → committed, lock node, wake waiters, broadcast event."""
        if node_id in self._flushed:
            return
        self._timers.pop(node_id, None)
        pending = self._pending.pop(node_id, [])
        if not pending:
            return
        self._actions[node_id] = pending
        self._flushed.add(node_id)
        self.get_event(node_id).set()
        # broadcast committed event (timer callback is sync — schedule task)
        try:
            loop = asyncio.get_event_loop()
            loop.create_task(
                self.broadcast(
                    session_id,
                    {
                        "type": "node_committed",
                        "session_id": session_id,
                        "payload": {
                            "node_id": node_id,
                            "actions": [a.model_dump() for a in pending],
                        },
                    },
                )
            )
            # flush flips has_pending if this was the last open node
            loop.create_task(self.broadcast_session_list())
        except RuntimeError:
            # no running loop (test teardown) — skip broadcast
            pass

    def clear_node_state(self, node_id: str) -> None:
        """End-of-session cleanup."""
        timer = self._timers.pop(node_id, None)
        if timer is not None:
            timer.cancel()
        self._actions.pop(node_id, None)
        self._pending.pop(node_id, None)
        self._events.pop(node_id, None)
        self._flushed.discard(node_id)

    def get_status_event(self, sid: str) -> asyncio.Event:
        ev = self._status_events.get(sid)
        if ev is None:
            ev = asyncio.Event()
            self._status_events[sid] = ev
        return ev

    def _bump_status_event(self, sid: str) -> None:
        """Wake current waiters and rotate to a fresh event for future waits.
        Avoids the set()+clear() race where a freshly-cleared event makes
        Event.wait() return False before the resumer can re-check state."""
        old = self._status_events.pop(sid, None)
        if old is not None:
            old.set()
        # next get_status_event call lazily creates a fresh, unset event

    def pause_session(
        self, sid: str, node_id: str, branch_id: Optional[str] = None
    ) -> tuple[Optional[Session], bool]:
        """Mark session paused (chat handoff to CC). Returns (session, changed)
        where changed=False if session was already paused on this exact
        (node_id, branch_id) pair — caller can skip re-broadcasting."""
        s = self.sessions.get(sid)
        if not s:
            return None, False
        already = (
            s.status == "paused"
            and s.paused_node_id == node_id
            and s.paused_branch_id == branch_id
        )
        s.status = "paused"
        s.paused_node_id = node_id
        s.paused_branch_id = branch_id
        if not already:
            self._bump_status_event(sid)
        return s, not already

    def resume_session(self, sid: str) -> Optional[Session]:
        """Flip paused → active. Called explicitly via resume_session MCP tool
        when user types 'resume' in CC, or implicitly when present_branches
        pushes a new node."""
        s = self.sessions.get(sid)
        if not s or s.status != "paused":
            return None
        s.status = "active"
        s.paused_node_id = None
        s.paused_branch_id = None
        self._bump_status_event(sid)
        return s

    # ---- branch state mutation from GUI ----
    def apply_action(self, action: GuiAction) -> Optional[AskBranchesResult]:
        """Mutate node state immediately + return action record for the buffer.

        Returns None on invalid input (no session, no node, missing required
        fields, locked node). Mutations apply right away regardless of when
        the buffer flushes, so the GUI feels responsive.
        """
        s = self.sessions.get(action.session_id)
        if not s:
            return None
        node = s.nodes.get(action.node_id)
        if not node:
            return None
        if action.node_id in self._flushed:
            return None  # locked

        if action.action == "stop":
            return AskBranchesResult(node_id=action.node_id, action="stop")

        if action.action in ("mark_rejected", "unmark") and action.branch_id:
            chosen = next(
                (b for b in node.branches if b.id == action.branch_id), None
            )
            if chosen is None:
                return None
            chosen.state = (
                "rejected" if action.action == "mark_rejected" else "considered"
            )
            return AskBranchesResult(
                node_id=action.node_id,
                chosen_branch_id=chosen.id,
                chosen_branch_label=chosen.label,
                action=action.action,
            )

        if action.action == "next":
            if not action.branch_id:
                return None
            chosen = next(
                (b for b in node.branches if b.id == action.branch_id), None
            )
            if chosen is None:
                return None
            for other in node.branches:
                if other.state == "chosen" and other.id != chosen.id:
                    other.state = "considered"
            chosen.state = "chosen"
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
            node.user_note = action.note
            return AskBranchesResult(
                node_id=action.node_id,
                note=action.note,
                action="other",
            )

        if action.action == "chat":
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

    # ---- hook traces ----
    def attach_hook(self, ev: HookEvent) -> None:
        sid = ev.grill_session_id or ev.session_id
        if not sid or sid not in self.sessions:
            return
        s = self.sessions[sid]
        node_id = ev.grill_node_id or "_unbound"
        s.hook_traces.setdefault(node_id, []).append(ev.model_dump())

    # ---- session-list helpers ----
    def _has_pending(self, sid: str) -> bool:
        """True when session has at least one non-implicit node not yet flushed.
        Paused / ended sessions never count — spec says * fires only on
        active sessions awaiting a click."""
        s = self.sessions.get(sid)
        if not s or s.status != "active":
            return False
        for nid, node in s.nodes.items():
            if node.implicit:
                continue
            if nid not in self._flushed:
                return True
        return False

    def _session_list_snapshot(self) -> dict[str, Any]:
        return {
            "type": "session_list",
            "session_id": "",
            "payload": {
                "sessions": [
                    {
                        "id": s.id,
                        "brief": s.brief,
                        "started_at": s.started_at,
                        "status": s.status,
                        "has_pending": self._has_pending(s.id),
                    }
                    for s in self.sessions.values()
                ]
            },
        }

    async def broadcast_session_list(self) -> None:
        """Fan a fresh session_list snapshot to every subscriber (per-session
        + global). Bypasses the per-session ring — list snapshots are derived
        state, not history."""
        ev = self._session_list_snapshot()
        async with self._lock:
            targets: list[asyncio.Queue[dict[str, Any]]] = list(self._global_subs)
            for subs in self._subs.values():
                targets.extend(subs)
        for q in targets:
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                pass

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
            # send fresh session list snapshot to every new subscriber
            await q.put(self._session_list_snapshot())
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
