"""Session store + pending-request map for the present_branches / wait_for_action loop."""
from __future__ import annotations

import asyncio
import logging
import os
import pathlib
import shutil
import time
import uuid
from collections import defaultdict, deque
from typing import Any, Optional

logger = logging.getLogger(__name__)

from .schemas import (
    AskBranchesResult,
    Branch,
    ChatBlock,
    ChatOps,
    CmuxInfo,
    GuiAction,
    HookEvent,
    Node,
    Session,
)

# sentinel value held in Session.wrap_summary_node_id between wrap_session()
# and the skill's first present_summary push. bind_wrap_summary swaps it for
# the real node id.
_WRAP_PENDING_SENTINEL = "__wrap_pending__"

MAX_RING = 5000  # per-session SSE replay buffer
DEBOUNCE_SECONDS = 0.75  # idle window before flushing buffered clicks
TERMINAL_ACTIONS = {
    "next", "chat",
    "stop_here", "create_plan", "implement_now", "continue_grill",
}
# subset that auto-end the session server-side after flush
SUMMARY_END_ACTIONS = {"stop_here", "create_plan", "implement_now"}
# project slugs whose persisted sessions are skipped on startup rehydrate
SKIP_LOAD_PROJECTS = {"smoke"}


class Store:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self.ring: dict[str, deque[dict[str, Any]]] = defaultdict(
            lambda: deque(maxlen=MAX_RING)
        )
        # node_id -> debounce timer handle (asyncio.TimerHandle from call_later)
        self._timers: dict[str, Any] = {}
        # node_id -> Event signalling buffer flushed (lazy-created in get_event)
        self._events: dict[str, asyncio.Event] = {}
        # session_id -> Event signalling status change (pause/resume)
        self._status_events: dict[str, asyncio.Event] = {}
        # SSE subscribers: session_id -> list[asyncio.Queue]
        self._subs: dict[str, list[asyncio.Queue[dict[str, Any]]]] = defaultdict(list)
        # global subscribers (all sessions, for index page)
        self._global_subs: list[asyncio.Queue[dict[str, Any]]] = []
        # owner-scoped subscribers: owner_id -> list[asyncio.Queue]. Only
        # receive events for sessions whose owner_id matches. Used by the
        # stdio shim so parallel CC instances don't cross-talk.
        self._owner_subs: dict[str, list[asyncio.Queue[dict[str, Any]]]] = defaultdict(list)
        self._lock = asyncio.Lock()
        # disk root for session JSON snapshots
        self._data_root: pathlib.Path = pathlib.Path.home() / ".grill-cheese"

    # ---- persistence ----
    def _session_dir(self, project: str) -> pathlib.Path:
        slug = project if project else "_default"
        return self._data_root / f"project-{slug}" / "sessions"

    def _trash_dir(self, project: str) -> pathlib.Path:
        slug = project if project else "_default"
        return self._data_root / f"project-{slug}" / "trash"

    def _persist(self, session: Session) -> None:
        """Atomic write of session JSON. Sync I/O — sessions are KB-scale."""
        d = self._session_dir(session.project)
        try:
            d.mkdir(parents=True, exist_ok=True)
            target = d / f"{session.id}.json"
            tmp = d / f"{session.id}.json.tmp"
            tmp.write_text(session.model_dump_json(), encoding="utf-8")
            os.replace(tmp, target)
        except Exception:
            logger.exception("persist failed for session %s", session.id)

    async def _load_all(self) -> None:
        """Scan ~/.grill-cheese/project-*/sessions/*.json and rehydrate.

        Skips dirs whose slug ∈ SKIP_LOAD_PROJECTS (e.g. smoke tests) so
        throwaway sessions don't pollute the dev GUI on server start.

        Discards transient pending_actions per design: a crash mid-debounce
        forfeits not-yet-flushed clicks (visible node state already persisted).
        """
        root = self._data_root
        if not root.exists():
            return
        # wipe all trash dirs unconditionally on startup — undo window for
        # deleted sessions is "until next server restart"
        for proj_dir in sorted(root.glob("project-*")):
            trash = proj_dir / "trash"
            if trash.exists():
                try:
                    shutil.rmtree(trash)
                except Exception:
                    logger.exception("failed to wipe trash dir %s", trash)
        for proj_dir in sorted(root.glob("project-*")):
            if not proj_dir.is_dir():
                continue
            slug = proj_dir.name[len("project-"):]
            if slug in SKIP_LOAD_PROJECTS:
                logger.info("skipping load of project dir %s", proj_dir.name)
                continue
            for f in sorted(proj_dir.glob("sessions/*.json")):
                if f.name.endswith(".bad") or f.name.endswith(".tmp"):
                    continue
                try:
                    raw = f.read_text(encoding="utf-8")
                    s = Session.model_validate_json(raw)
                except Exception:
                    logger.exception("corrupt session file %s — renaming .bad", f)
                    try:
                        f.rename(f.with_suffix(".json.bad"))
                    except Exception:
                        pass
                    continue
                for node in s.nodes.values():
                    node.pending_actions = []
                self.sessions[s.id] = s
                logger.info("rehydrated session %s (%s)", s.id, s.brief[:60])

    def _find_node(self, node_id: str) -> Optional[tuple[Session, Node]]:
        for s in self.sessions.values():
            node = s.nodes.get(node_id)
            if node is not None:
                return s, node
        return None

    # ---- sessions ----
    def new_session(
        self, title: str, brief: str, project: str, owner_id: Optional[str] = None
    ) -> Session:
        sid = uuid.uuid4().hex[:12]
        s = Session(
            id=sid, title=title, brief=brief, project=project,
            started_at=time.time(), owner_id=owner_id,
        )
        self.sessions[sid] = s
        self._persist(s)
        return s

    async def set_session_cmux(self, sid: str, cmux: CmuxInfo) -> bool:
        """Stamp cmux coords post-hoc. Called by internal_dispatch on
        start_session when X-Grill-Cmux header is present. Idempotent —
        re-stamping with the same payload is a no-op. Different payload
        overwrites (handy when shim restarts inside same cmux panel).

        Broadcasts session_meta on change so a live GUI (already
        subscribed to /events before start_session fired session_started
        without cmux) hydrates the deep-link without a full reload."""
        async with self._lock:
            s = self.sessions.get(sid)
            if s is None:
                return False
            if s.cmux == cmux:
                return True
            s.cmux = cmux
        self._persist(s)
        await self.broadcast(
            sid,
            {
                "type": "session_meta",
                "session_id": sid,
                "payload": {"cmux": cmux.model_dump()},
            },
        )
        return True

    async def set_session_owner(self, sid: str, owner_id: str) -> bool:
        """Stamp owner_id post-hoc. Used by internal_dispatch on start_session
        when an X-Grill-Owner header is present. No-op if session is missing
        or already has a different owner (treat as race / replay).

        Async + lock-protected because broadcast() reads owner_id under
        self._lock to route events; setter must serialize with that read,
        otherwise the first node_committed after start_session can race
        the stamp and miss the owner bucket."""
        if not owner_id:
            return False
        async with self._lock:
            s = self.sessions.get(sid)
            if s is None:
                return False
            if s.owner_id and s.owner_id != owner_id:
                return False
            if s.owner_id == owner_id:
                return True
            s.owner_id = owner_id
        self._persist(s)
        return True

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
        kind: Optional[str] = None,
        summary_body: Optional[str] = None,
        multi_select: bool = False,
        generate_docs: bool = False,
        docs_reason: Optional[str] = None,
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
            kind=kind,
            summary_body=summary_body,
            multi_select=multi_select,
            generate_docs=generate_docs,
            docs_reason=docs_reason,
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
        self._persist(s)
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
        found = self._find_node(node_id)
        if found is None:
            return None
        _, node = found
        return node.committed_actions if node.is_flushed else None

    def is_flushed(self, node_id: str) -> bool:
        found = self._find_node(node_id)
        return bool(found and found[1].is_flushed)

    def enqueue_action(
        self, session_id: str, node_id: str, record: AskBranchesResult
    ) -> bool:
        """Append record to pending buffer + reset 750ms idle timer.
        Returns False if node already locked (caller should reject).

        Does NOT persist — the calling endpoint persists once after both
        apply_action + enqueue_action mutate the session."""
        s = self.sessions.get(session_id)
        if not s:
            return False
        node = s.nodes.get(node_id)
        if not node or node.is_flushed:
            return False
        node.pending_actions.append(record)
        existing = self._timers.pop(node_id, None)
        if existing is not None:
            existing.cancel()
        loop = asyncio.get_event_loop()
        self._timers[node_id] = loop.call_later(
            DEBOUNCE_SECONDS, self._flush, session_id, node_id
        )
        return True

    def flush_now(self, session_id: str, node_id: str) -> None:
        """Bypass idle timer — used by terminal-class clicks (next/chat + verdicts)."""
        existing = self._timers.pop(node_id, None)
        if existing is not None:
            existing.cancel()
        self._flush(session_id, node_id)

    def _flush(self, session_id: str, node_id: str) -> None:
        """Move pending → committed, lock node, wake waiters, broadcast event."""
        s = self.sessions.get(session_id)
        if not s:
            return
        node = s.nodes.get(node_id)
        if not node or node.is_flushed:
            return
        self._timers.pop(node_id, None)
        pending = node.pending_actions[:]
        if not pending:
            return
        node.pending_actions = []
        node.committed_actions = pending
        node.is_flushed = True
        # assign monotonic per-session seq for channel skip-detection
        seq = s.next_seq
        s.next_seq += 1
        self._persist(s)
        self.get_event(node_id).set()
        # broadcast committed event (timer callback is sync — schedule task)
        try:
            loop = asyncio.get_event_loop()
            # Summary-node doc fields flow on the same event so the skill sees
            # them when channel wakes it on create_plan / stop_here — without
            # this it would need an extra get_session_snapshot round-trip just
            # to know whether to write a doc-first plan.
            payload: dict[str, Any] = {
                "node_id": node_id,
                "seq": seq,
                "actions": [a.model_dump() for a in pending],
            }
            if node.kind == "summary":
                payload["generate_docs"] = node.generate_docs
                payload["docs_reason"] = node.docs_reason
            loop.create_task(
                self.broadcast(
                    session_id,
                    {
                        "type": "node_committed",
                        "session_id": session_id,
                        "payload": payload,
                    },
                )
            )
            # flush flips has_pending if this was the last open node
            loop.create_task(self.broadcast_session_list())
        except RuntimeError:
            # no running loop (test teardown) — skip broadcast
            pass

    def clear_node_state(self, session_id: str, node_id: str) -> None:
        """End-of-session cleanup. Caller persists once after batch."""
        timer = self._timers.pop(node_id, None)
        if timer is not None:
            timer.cancel()
        self._events.pop(node_id, None)
        s = self.sessions.get(session_id)
        if not s:
            return
        node = s.nodes.get(node_id)
        if node:
            node.pending_actions = []
            node.committed_actions = []
            node.is_flushed = False

    def unlock_node(self, session_id: str, node_id: str) -> None:
        """Unlock a flushed node so clicks can resume.

        Used by apply_chat_result on refine: chat result mutates the node;
        node must accept new clicks (pick / chat again / etc) afterwards.
        Drops the committed batch since the next round of clicks belongs
        to a fresh wait_for_action cycle.
        """
        timer = self._timers.pop(node_id, None)
        if timer is not None:
            timer.cancel()
        s = self.sessions.get(session_id)
        if s:
            node = s.nodes.get(node_id)
            if node:
                node.pending_actions = []
                node.committed_actions = []
                node.is_flushed = False
            self._persist(s)
        # rotate event so old waiters who already returned do not re-fire
        old = self._events.pop(node_id, None)
        if old is not None and not old.is_set():
            old.set()  # release any stragglers

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
        self._persist(s)
        return s, not already

    async def wrap_session(self, sid: str) -> Optional[Session]:
        """Mark a session as awaiting verdict-card composition.

        Sets wrap_summary_node_id to a sentinel and broadcasts session_wrap so
        the shim wakes the skill. The skill's next present_summary call swaps
        the sentinel for the real summary node id (see add_summary_node).

        Idempotent: if already wrapping, returns the session without
        re-broadcasting (double-click wrap-up is fine).
        """
        s = self.sessions.get(sid)
        if not s or s.status == "ended":
            return None
        if s.wrap_summary_node_id is not None:
            return s  # already wrapping
        s.wrap_summary_node_id = _WRAP_PENDING_SENTINEL
        self._persist(s)
        await self.broadcast(
            sid,
            {"type": "session_wrap", "session_id": sid, "payload": {}},
        )
        return s

    def bind_wrap_summary(self, sid: str, node_id: str) -> None:
        """Swap wrap sentinel for the real summary node id. No-op if no wrap."""
        s = self.sessions.get(sid)
        if not s or s.wrap_summary_node_id != _WRAP_PENDING_SENTINEL:
            return
        s.wrap_summary_node_id = node_id
        self._persist(s)

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
        self._persist(s)
        return s

    # ---- delete ----
    async def delete_session(self, sid: str) -> bool:
        """Move session.json + .events.jsonl to per-project trash/, drop all
        in-memory state, broadcast session_deleted + session_list. Trash is
        wiped on next server startup.

        Active/paused sessions are torn down too — caller must have user
        confirm beforehand (GUI does this via window.confirm()).
        """
        s = self.sessions.get(sid)
        if s is None:
            return False
        project = s.project
        owner = s.owner_id

        # cancel any debounce timers + release per-node event waiters.
        # Mirror unlock_node's pattern: .set() any unset event before dropping
        # so stragglers awaiting get_event(node_id).wait() unblock.
        for node_id in list(s.nodes.keys()):
            timer = self._timers.pop(node_id, None)
            if timer is not None:
                timer.cancel()
            old_ev = self._events.pop(node_id, None)
            if old_ev is not None and not old_ev.is_set():
                old_ev.set()
        # rotate status event so any waiters unblock
        old_status = self._status_events.pop(sid, None)
        if old_status is not None and not old_status.is_set():
            old_status.set()

        # move files (json + jsonl sibling pair) to trash
        sess_dir = self._session_dir(project)
        trash_dir = self._trash_dir(project)
        try:
            trash_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            logger.exception("failed to mkdir trash %s", trash_dir)
        for name in (f"{sid}.json", f"{sid}.events.jsonl"):
            src = sess_dir / name
            if src.exists():
                dst = trash_dir / name
                try:
                    os.replace(src, dst)
                except Exception:
                    logger.exception("failed to move %s -> %s", src, dst)

        # drop in-memory state
        self.sessions.pop(sid, None)
        self.ring.pop(sid, None)

        # broadcast session_deleted to per-sid + global + owner subs.
        # Built inline because self.broadcast() reads owner_id from
        # sessions[sid] under the lock, and we just popped it.
        ev = {
            "type": "session_deleted",
            "session_id": sid,
            "payload": {"project": project},
        }
        async with self._lock:
            targets: list[asyncio.Queue[dict[str, Any]]] = (
                list(self._subs.get(sid, [])) + list(self._global_subs)
            )
            if owner:
                targets += list(self._owner_subs.get(owner, []))
        for q in targets:
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                pass

        await self.broadcast_session_list()
        return True

    # ---- branch state mutation from GUI ----
    def apply_action(self, action: GuiAction) -> Optional[AskBranchesResult]:
        """Mutate node state immediately + return action record for the buffer.

        Returns None on invalid input (no session, no node, missing required
        fields, locked node, picking a removed branch). Mutations apply right
        away regardless of when the buffer flushes, so the GUI feels responsive.
        """
        s = self.sessions.get(action.session_id)
        if not s:
            return None
        node = s.nodes.get(action.node_id)
        if not node:
            return None
        if node.is_flushed:
            return None  # locked

        # wrap gate: once wrap fires, only verdict actions on the summary node
        # are accepted. blocks late next/chat on the pre-wrap pending node.
        if (
            s.wrap_summary_node_id is not None
            and action.node_id != s.wrap_summary_node_id
            and action.action in ("next", "chat")
        ):
            return None

        if action.action == "stop_here":
            return AskBranchesResult(
                node_id=action.node_id, action="stop_here"
            )

        if action.action in ("create_plan", "implement_now"):
            return AskBranchesResult(
                node_id=action.node_id,
                action=action.action,
                chain_markdown=self._build_chain_md(s),
            )

        if action.action == "continue_grill":
            # synthesize a "continue" branch on the summary node so the next
            # present_branches can wire its parent_branch_id to it and dagre
            # renders the edge.
            cont = Branch(
                id=uuid.uuid4().hex[:8],
                label="continue",
                rationale="",
                is_recommended=False,
            )
            node.branches.append(cont)
            node.chosen_branch_ids = [cont.id]
            return AskBranchesResult(
                node_id=action.node_id,
                chosen_branch_ids=[cont.id],
                chosen_branch_labels=[cont.label],
                note=action.note,
                action="continue_grill",
            )

        if action.action == "next":
            chosen_ids: list[str] = []
            chosen_labels: list[str] = []
            for bid in action.branch_ids:
                if bid in node.removed_branch_ids:
                    return None
                b = next((x for x in node.branches if x.id == bid), None)
                if b is None:
                    return None
                chosen_ids.append(b.id)
                chosen_labels.append(b.label)
            # synth-branch path: typed text becomes a user_authored Branch on
            # the node and is included in the chosen set on the same submit.
            note = (action.note or "").strip()
            if note:
                synth = Branch(
                    label=note[:60],
                    rationale=note,
                    is_recommended=False,
                    user_authored=True,
                )
                node.branches.append(synth)
                chosen_ids.append(synth.id)
                chosen_labels.append(synth.label)
            # min=1: must have at least one branch_id OR non-empty note
            if not chosen_ids:
                return None
            node.chosen_branch_ids = chosen_ids
            return AskBranchesResult(
                node_id=action.node_id,
                chosen_branch_ids=chosen_ids,
                chosen_branch_labels=chosen_labels,
                note=action.note,
                action="next",
            )

        if action.action == "chat":
            scoped = None
            if action.branch_id:
                if action.branch_id in node.removed_branch_ids:
                    return None  # cannot chat about a removed branch
                scoped = next(
                    (b for b in node.branches if b.id == action.branch_id), None
                )
                if scoped is None:
                    return None
            return AskBranchesResult(
                node_id=action.node_id,
                chat_branch_id=scoped.id if scoped else None,
                chat_branch_label=scoped.label if scoped else None,
                action="chat",
            )
        return None

    # ---- apply_chat_result (chat outcome -> node mutation) ----
    def apply_chat_result(
        self,
        sid: str,
        node_id: str,
        chat_id: str,
        chat_summary: str,
        outcome: str,
        ops: Optional[ChatOps],
    ) -> tuple[Optional[Node], Optional[str], Optional[str]]:
        """Apply a chat outcome to the chatted node.

        Returns (node, redirect_branch_id, err).
          - err is None on success or a short error string.
          - redirect_branch_id is set ONLY for the redirect outcome — it's the
            synthesized 'redirect' branch the next present_branches must use
            as parent_branch_id so the tree stays connected on canvas + in
            chain_markdown/export walks.

        On idempotent replay (same chat_id already applied), returns the cached
        node + (the matching ChatBlock's branch_id if outcome was redirect)
        + None err.

        All-or-nothing for refine: any invalid branch ref -> err, no partial
        apply. Outcome-specific mutations:
          - refine:   ops.removes ids -> node.removed_branch_ids; ops.adds
                      appended to node.branches.
          - redirect: node.redirected = True. Synthesize a 'redirect' branch
                      with first 60 chars of summary as label. Return its id.
          - resolve:  synthesize a chosen branch (label = first 60 chars of
                      summary) and set chosen_branch_ids = [synth_id].

        On success: appends ChatBlock, unlocks node for refine/resolve,
        resumes session (status -> active).
        """
        s = self.sessions.get(sid)
        if not s:
            return None, None, "no such session"
        node = s.nodes.get(node_id)
        if not node:
            return None, None, "no such node"
        if outcome not in ("refine", "redirect", "resolve"):
            return None, None, f"bad outcome: {outcome}"

        # idempotency: if chat_id already applied, return cached node unchanged.
        # For redirect, also re-emit the synthesized branch_id so retries get
        # the same parent_branch_id to wire children with.
        for existing in node.chats:
            if existing.chat_id == chat_id:
                cached_redirect_bid = None
                if existing.outcome == "redirect":
                    # find the redirect branch — it's the most recently appended
                    # branch with rationale=='redirected via chat'. Robust enough
                    # for our purposes (one redirect per chat).
                    for b in reversed(node.branches):
                        if b.rationale == "redirected via chat":
                            cached_redirect_bid = b.id
                            break
                return node, cached_redirect_bid, None

        # validate ops on refine before any mutation (all-or-nothing)
        if outcome == "refine":
            ops = ops or ChatOps()
            existing_ids = {b.id for b in node.branches}
            for rid in ops.removes:
                if rid not in existing_ids:
                    return None, None, f"unknown branch id in removes: {rid}"
            # generate fresh ids for adds; ensure no clash with existing
            for add in ops.adds:
                if not add.id:
                    add.id = uuid.uuid4().hex[:8]
                if add.id in existing_ids:
                    return None, None, f"add branch id collides: {add.id}"
                existing_ids.add(add.id)

        # apply
        redirect_branch_id: Optional[str] = None
        if outcome == "refine":
            assert ops is not None
            for rid in ops.removes:
                if rid not in node.removed_branch_ids:
                    node.removed_branch_ids.append(rid)
            node.branches.extend(ops.adds)
        elif outcome == "redirect":
            node.redirected = True
            # synthesize a 'redirect' branch so the post-redirect question node
            # can wire its parent_branch_id to it — keeps the tree connected
            # on canvas + in chain_markdown/export walks. Caller (the MCP tool)
            # returns this id so Claude can pass it to next present_branches.
            label = chat_summary.strip().splitlines()[0] if chat_summary else "redirect"
            label = (label[:60] or "redirect")
            redir = Branch(
                id=uuid.uuid4().hex[:8],
                label=label,
                rationale="redirected via chat",
                is_recommended=False,
            )
            node.branches.append(redir)
            redirect_branch_id = redir.id
            # do NOT set chosen_branch_ids — chosen means "user picked"; redirect
            # means "abandoned via chat". Tree wiring uses the synthesized
            # branch's child_node_id once a follow-up node hangs off it.
        elif outcome == "resolve":
            label = chat_summary.strip().splitlines()[0] if chat_summary else "resolved via chat"
            label = label[:60] or "resolved via chat"
            resolved = Branch(
                id=uuid.uuid4().hex[:8],
                label=label,
                rationale="resolved via chat",
                is_recommended=True,
            )
            node.branches.append(resolved)
            node.chosen_branch_ids = [resolved.id]

        # log the chat
        node.chats.append(
            ChatBlock(
                chat_id=chat_id,
                summary=chat_summary,
                outcome=outcome,  # type: ignore[arg-type]
                applied_at=time.time(),
                branch_id=s.paused_branch_id,
            )
        )

        # unlock node (refine/resolve) so user can interact again. redirect
        # leaves the node read-only — user moves on to the new question.
        if outcome in ("refine", "resolve"):
            self.unlock_node(sid, node_id)

        # flip session back to active
        if s.status == "paused":
            s.status = "active"
            s.paused_node_id = None
            s.paused_branch_id = None
            self._bump_status_event(sid)

        self._persist(s)
        return node, redirect_branch_id, None

    # ---- chain markdown (chosen-path only) ----
    def _build_chain_md(self, session: Session) -> str:
        """Render the chosen-path chain as markdown for create_plan / implement_now.

        Walks from root following chosen branches (Node.chosen_branch_ids[0]
        as canonical next-hop). For multi-mode nodes, all picks render in the
        Chose: line. Redirected nodes follow the parent-branch wiring of the
        next node since the chatted node has no chosen branch.
        """
        title = session.title or session.brief[:80]
        iso = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(session.started_at))
        lines = [
            f"# {title}",
            "",
            f"*Session: {session.id} · started: {iso}*",
            "",
            f"**Brief:** {session.brief}",
            "",
        ]
        if not session.root_node_id:
            return "\n".join(lines)
        visited: set[str] = set()
        node_id: Optional[str] = session.root_node_id
        depth = 0
        while node_id and node_id not in visited:
            visited.add(node_id)
            n = session.nodes.get(node_id)
            if not n:
                break
            if n.kind == "summary":
                h = "#" * (depth + 2)
                lines.append(f"{h} Summary")
                if n.summary_body:
                    lines.append("")
                    lines.append(n.summary_body)
                lines.append("")
                chosen_list = _chosen_branches(n)
                node_id = chosen_list[0].child_node_id if chosen_list else None
                depth += 1
                continue
            h = "#" * (depth + 2)
            tag = " *(redirected via chat)*" if n.redirected else ""
            lines.append(f"{h} {n.question}{tag}")
            if n.reasoning:
                lines.append(f"> {n.reasoning}")
            # inline chat callouts (one per applied chat)
            for c in n.chats:
                lines.append("")
                lines.append(f"> **Chat ({c.outcome}):** {c.summary}")
            chosen_list = _chosen_branches(n)
            if chosen_list:
                lines.append("")
                if len(chosen_list) == 1:
                    c = chosen_list[0]
                    tag = " *[typed]*" if c.user_authored else ""
                    lines.append(f"**Chose:** {c.label}{tag}")
                    if c.rationale and not c.user_authored:
                        lines.append(f"_{c.rationale}_")
                else:
                    parts = [
                        f"{c.label}" + (" *[typed]*" if c.user_authored else "")
                        for c in chosen_list
                    ]
                    lines.append(f"**Chose:** {', '.join(parts)}")
            lines.append("")
            # advance: prefer first chosen branch's child; fall back to first
            # child that exists (handles redirect — chatted node has no chosen,
            # but one of its branches still has a child_node_id).
            next_id = chosen_list[0].child_node_id if chosen_list else None
            if next_id is None:
                for b in n.branches:
                    if b.child_node_id:
                        next_id = b.child_node_id
                        break
            node_id = next_id
            depth += 1
        return "\n".join(lines)

    # ---- hook traces ----
    def attach_hook(self, ev: HookEvent) -> None:
        sid = ev.grill_session_id or ev.session_id
        if not sid or sid not in self.sessions:
            return
        s = self.sessions[sid]
        # tag chat-time tool calls so GUI can render them distinctly
        if (
            s.status == "paused"
            and ev.grill_node_id
            and ev.grill_node_id == s.paused_node_id
        ):
            ev.chat_tag = True
        node_id = ev.grill_node_id or "_unbound"
        s.hook_traces.setdefault(node_id, []).append(ev.model_dump())
        self._persist(s)

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
            if not node.is_flushed:
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
                        "title": s.title,
                        "brief": s.brief,
                        "project": s.project,
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
        self,
        sid: Optional[str] = None,
        owner: Optional[str] = None,
    ) -> asyncio.Queue[dict[str, Any]]:
        """Subscribe to SSE events.

        Bucket selection (mutually exclusive, precedence top-down):
          - owner: receive events for every session whose owner_id == owner.
                   Used by the stdio shim (one bucket per shim uuid).
          - sid:   receive events for one specific session. Used by the
                   GUI session-detail view.
          - neither: global — every event. Used by the GUI index page.
        """
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=512)
        async with self._lock:
            if owner:
                self._owner_subs[owner].append(q)
                # replay ring for every session this owner owns so a
                # restarting shim catches flushed-but-not-delivered events
                for s_id, s in self.sessions.items():
                    if s.owner_id == owner:
                        for ev in list(self.ring[s_id]):
                            await q.put(ev)
            elif sid:
                self._subs[sid].append(q)
                for ev in list(self.ring[sid]):
                    await q.put(ev)
            else:
                self._global_subs.append(q)
            await q.put(self._session_list_snapshot())
        return q

    async def unsubscribe(
        self,
        sid: Optional[str],
        q: asyncio.Queue[dict[str, Any]],
        owner: Optional[str] = None,
    ) -> None:
        async with self._lock:
            if owner and q in self._owner_subs.get(owner, []):
                self._owner_subs[owner].remove(q)
            elif sid and q in self._subs.get(sid, []):
                self._subs[sid].remove(q)
            elif q in self._global_subs:
                self._global_subs.remove(q)

    async def broadcast(self, sid: str, ev: dict[str, Any]) -> None:
        async with self._lock:
            # ring append + session existence check happen under the lock so
            # a delete_session that popped sessions[sid] races cleanly: any
            # _flush-scheduled broadcast for the deleted sid drops here
            # instead of resurrecting ring[sid] via defaultdict.
            s = self.sessions.get(sid)
            if s is None:
                return
            owner = s.owner_id
            self.ring[sid].append(ev)
            targets = list(self._subs.get(sid, [])) + list(self._global_subs)
            if owner:
                targets += list(self._owner_subs.get(owner, []))
        for q in targets:
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                pass


def _chosen_branches(n: Node) -> list[Branch]:
    """All chosen Branch objs, in pick order. Plural is the truth — radio
    mode just has length 1."""
    by_id = {b.id: b for b in n.branches}
    out: list[Branch] = []
    for bid in n.chosen_branch_ids:
        b = by_id.get(bid)
        if b is not None:
            out.append(b)
    return out


def _chosen_branch(n: Node) -> Optional[Branch]:
    """Back-compat: first chosen branch (or None). Use _chosen_branches when
    multi-pick matters."""
    cl = _chosen_branches(n)
    return cl[0] if cl else None


store = Store()
