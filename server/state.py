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
    ChatMessage,
    ChatOps,
    CmuxInfo,
    GuiAction,
    HookEvent,
    Node,
    PendingProposal,
    PerformanceEntry,
    Session,
)

# sentinel value held in Session.wrap_summary_node_id between wrap_session()
# and the skill's first present_summary push. bind_wrap_summary swaps it for
# the real node id.
_WRAP_PENDING_SENTINEL = "__wrap_pending__"

MAX_RING = 5000  # per-session SSE replay buffer
DEBOUNCE_SECONDS = 0.75  # idle window before flushing buffered clicks
# `chat` removed (ADR-0001): non-blocking chat means no chat action commits.
TERMINAL_ACTIONS = {
    "next",
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
        self,
        title: str,
        brief: str,
        project: str,
        owner_id: Optional[str] = None,
        kind: Optional[str] = None,
    ) -> Session:
        sid = uuid.uuid4().hex[:12]
        s = Session(
            id=sid, title=title, brief=brief, project=project,
            started_at=time.time(), owner_id=owner_id, kind=kind,
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
        progress: Optional[float] = None,
    ) -> Node:
        s = self.sessions[sid]
        node_id = uuid.uuid4().hex[:10]
        for b in branches:
            if not b.id:
                b.id = uuid.uuid4().hex[:8]
        # honest-shrink progress: clamp to [0,1] silently. ADR-0007.
        # accept str "0.1" too — CC sometimes ships floats as strings.
        if progress is not None:
            try:
                progress = max(0.0, min(1.0, float(progress)))
            except (TypeError, ValueError):
                progress = None
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
            progress=progress,
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
        # pick-rate score is pinned at commit on a `next` flush. Summary
        # verdicts (stop_here / create_plan / implement_now / continue_grill)
        # don't carry a recommendation, so they leave the field None.
        last_action = pending[-1].action if pending else None
        if node.kind != "summary" and last_action == "next":
            node.recommendation_score = _compute_recommendation_score(node)
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
                # reconsider queue snapshot — lets Claude see pending marks
                # on every normal commit wake without an extra
                # get_session_snapshot round-trip. See ADR-0009.
                "pending_reconsiders": list(s.reconsider_queue),
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

    # unlock_node removed in ADR-0001 (non-blocking chat). The chat path
    # no longer locks the node, so there's nothing to unlock. The historic
    # caller (apply_chat_result on refine) used it to clear is_flushed and
    # drop the committed batch — silent dataloss if invoked now, since a
    # node that the user already committed on would have its answer wiped.

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

    # ---- perf log emit ----
    def emit_performance_entry(self, sid: str, verdict: str) -> None:
        """Append one perf log line for a just-ended session. Idempotent —
        guards on `s.status == "ended"` so re-calls (or both callers firing
        for the same session) only land one row in performance.jsonl.
        Callers MUST set `s.status = "ended"` AFTER this returns (the guard
        is what dedups). Errors swallowed inside performance.append so a
        perf failure never blocks the session-end path.
        """
        from . import performance  # local import: avoid top-level cycle risk

        s = self.sessions.get(sid)
        if s is None:
            return
        if s.status == "ended":
            # Already emitted on a prior end-of-session path (hooks summary
            # verdict ran before, or end_session was called twice). Dedup.
            return
        if verdict not in ("stop_here", "create_plan", "implement_now", "end_session"):
            logger.warning("perf emit: skipping unknown verdict %r", verdict)
            return
        scores = [
            n.recommendation_score
            for n in s.nodes.values()
            if n.recommendation_score is not None
        ]
        mean = sum(scores) / len(scores) if scores else None
        entry = PerformanceEntry(
            session_id=s.id,
            project=s.project,
            title=s.title,
            ended_at=time.time(),
            score=mean,
            decision_count=len(scores),
            verdict=verdict,  # type: ignore[arg-type]
            kind=s.kind,
        )
        performance.append(entry)

    # ---- delete ----
    async def delete_session(self, sid: str) -> bool:
        """Move session.json + .events.jsonl to per-project trash/, drop all
        in-memory state, broadcast session_deleted + session_list. Trash is
        wiped on next server startup.

        Active sessions are torn down too — caller must have user
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
        # are accepted. blocks late `next` on the pre-wrap pending node.
        if (
            s.wrap_summary_node_id is not None
            and action.node_id != s.wrap_summary_node_id
            and action.action == "next"
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
                own_answer=action.own_answer,
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
            # Own Answer path: typed text becomes a user_authored Branch on
            # the node and is included in the chosen set on the same submit.
            own = (action.own_answer or "").strip()
            if own:
                synth = Branch(
                    label=own[:60],
                    rationale=own,
                    is_recommended=False,
                    user_authored=True,
                )
                node.branches.append(synth)
                chosen_ids.append(synth.id)
                chosen_labels.append(synth.label)
            # min=1: must have at least one branch_id OR non-empty own_answer
            if not chosen_ids:
                return None
            node.chosen_branch_ids = chosen_ids
            return AskBranchesResult(
                node_id=action.node_id,
                chosen_branch_ids=chosen_ids,
                chosen_branch_labels=chosen_labels,
                own_answer=action.own_answer,
                action="next",
            )

        return None

    # ---- reconsider mark (🚩) ----
    def mark_node_reconsider(
        self, sid: str, node_id: str
    ) -> tuple[bool, Optional[str]]:
        """Flag a committed decision node for re-grilling. Returns (ok, err).

        Idempotent on re-click of an already-marked node (no-op). Excludes
        un-flushed (still-pending), summary, and implicit nodes. Persists +
        broadcasts node_reconsider_marked SSE on success. No buffer; the
        action is terminal-class but doesn't participate in click-flush.

        See ADR-0009.
        """
        s = self.sessions.get(sid)
        if not s:
            return False, "not_found"
        if s.status == "ended":
            return False, "session_ended"
        node = s.nodes.get(node_id)
        if not node:
            return False, "not_found"
        if not node.is_flushed:
            return False, "node_not_committed"
        if node.kind == "summary":
            return False, "summary_node"
        if node.implicit:
            return False, "implicit_node"
        # idempotent re-click — already marked / seen stays put
        if node.reconsider_marked in ("marked", "seen"):
            return True, None
        node.reconsider_marked = "marked"
        if node_id not in s.reconsider_queue:
            s.reconsider_queue.append(node_id)
        self._persist(s)
        try:
            loop = asyncio.get_event_loop()
            loop.create_task(
                self.broadcast(
                    sid,
                    {
                        "type": "node_reconsider_marked",
                        "session_id": sid,
                        "payload": {
                            "node_id": node_id,
                            "reconsider_marked": node.reconsider_marked,
                            "reconsider_queue": list(s.reconsider_queue),
                        },
                    },
                )
            )
        except RuntimeError:
            pass
        return True, None

    def confirm_node_reconsider_seen(self, sid: str, node_id: str) -> bool:
        """Flip marked → seen. Called when the shim confirms it emitted the
        channel notification. Idempotent: no-op if state isn't 'marked'."""
        s = self.sessions.get(sid)
        if not s:
            return False
        node = s.nodes.get(node_id)
        if not node or node.reconsider_marked != "marked":
            return False
        node.reconsider_marked = "seen"
        self._persist(s)
        try:
            loop = asyncio.get_event_loop()
            loop.create_task(
                self.broadcast(
                    sid,
                    {
                        "type": "node_reconsider_marked",
                        "session_id": sid,
                        "payload": {
                            "node_id": node_id,
                            "reconsider_marked": node.reconsider_marked,
                            "reconsider_queue": list(s.reconsider_queue),
                        },
                    },
                )
            )
        except RuntimeError:
            pass
        return True

    # ---- inline-chat: transcript + proposal + accept/close ----
    def append_chat_message(
        self,
        sid: str,
        node_id: str,
        chat_id: str,
        msg_id: str,
        role: str,
        text: str,
    ) -> tuple[Optional[ChatMessage], Optional[int], Optional[str]]:
        """Append a chat message to the live transcript. Returns
        (message, seq, err). seq is the per-session monotonic seq
        consumed for this message (shared with node_committed counter so
        the skill's last_seen tracking sees a single contiguous stream).

        Idempotent on msg_id: replaying with the same id returns the
        existing message + no new seq (seq=None). Caller MUST NOT re-emit
        the channel notification for replays.
        """
        if role not in ("user", "assistant"):
            return None, None, f"bad role: {role}"
        s = self.sessions.get(sid)
        if not s:
            return None, None, "no such session"
        node = s.nodes.get(node_id)
        if not node:
            return None, None, "no such node"
        # idempotent: same msg_id already appended -> return cached, no seq
        for existing in node.chat_messages:
            if existing.msg_id == msg_id:
                return existing, None, None
        msg = ChatMessage(
            msg_id=msg_id, role=role, text=text, ts=time.time(),  # type: ignore[arg-type]
        )
        node.chat_messages.append(msg)
        seq = s.next_seq
        s.next_seq += 1
        self._persist(s)
        return msg, seq, None

    def set_pending_proposals(
        self,
        sid: str,
        node_id: str,
        chat_id: str,
        proposals: list[dict],
    ) -> tuple[Optional[list[PendingProposal]], Optional[str]]:
        """Stage (or replace) the chat outcome proposals on the node.

        Callers (currently only post_chat_message) MUST validate via
        validate_proposals() first — that's the atomic gate that decides
        whether the chat message gets appended. This method re-checks
        only the lightweight state invariants (session/node) and trusts
        proposal shape from the caller. Existing list is REPLACED
        atomically on success (no stacking).
        """
        if not proposals:
            return None, "proposals required (non-empty list)"
        s = self.sessions.get(sid)
        if not s:
            return None, "no such session"
        node = s.nodes.get(node_id)
        if not node:
            return None, "no such node"
        now = time.time()
        staged: list[PendingProposal] = []
        for p in proposals:
            outcome = p["outcome"]
            ops_dict = p.get("ops")
            staged_ops = ChatOps.model_validate(ops_dict) if outcome == "refine" else None
            staged.append(
                PendingProposal(
                    chat_id=chat_id,
                    outcome=outcome,
                    ops=staged_ops,
                    summary=p["summary"],
                    proposed_at=now,
                )
            )
        node.pending_proposals = staged
        self._persist(s)
        return staged, None

    def validate_proposals(
        self,
        sid: str,
        node_id: str,
        proposals: list[dict],
    ) -> Optional[str]:
        """Validate a proposals batch BEFORE staging. Returns None on OK,
        an error string on failure. Pure check — never mutates state.
        Used by post_chat_message to atomically reject the whole tool
        call (no message append, no stage) when any proposal is bad.
        """
        if not isinstance(proposals, list) or not proposals:
            return "proposals must be a non-empty list"
        s = self.sessions.get(sid)
        node = s.nodes.get(node_id) if s else None
        existing_branch_ids = {b.id for b in node.branches} if node else set()
        for idx, p in enumerate(proposals):
            if not isinstance(p, dict):
                return f"proposals[{idx}]: must be an object"
            outcome = p.get("outcome")
            summary = p.get("summary")
            ops_raw = p.get("ops")
            # `resolve` removed in ADR-0001.
            if outcome not in ("refine", "redirect"):
                return f"proposals[{idx}]: bad outcome: {outcome}"
            if not summary:
                return f"proposals[{idx}]: summary required"
            if outcome == "refine":
                try:
                    ops_obj = ChatOps.model_validate(ops_raw or {})
                except Exception as e:
                    return f"proposals[{idx}]: bad ops: {e}"
                for rid in ops_obj.removes:
                    if rid not in existing_branch_ids:
                        return f"proposals[{idx}]: unknown branch id in removes: {rid}"
            elif ops_raw:
                return f"proposals[{idx}]: ops only valid for refine, got {outcome}"
        return None

    def accept_proposal(
        self, sid: str, node_id: str, proposal_id: Optional[str] = None
    ) -> tuple[Optional[Node], Optional[str], Optional[str]]:
        """Commit ONE staged proposal (picked by proposal_id): applies via
        apply_chat_result, then clears live transcript / pending_proposals.
        When proposal_id is None and exactly one is staged, the sole
        proposal is picked. Returns (node, redirect_branch_id, err).
        """
        s = self.sessions.get(sid)
        if not s:
            return None, None, "no such session"
        node = s.nodes.get(node_id)
        if not node:
            return None, None, "no such node"
        props = node.pending_proposals
        if not props:
            return None, None, "no proposal staged"
        if proposal_id is None:
            if len(props) > 1:
                return None, None, "proposal_id required (multiple staged)"
            prop = props[0]
        else:
            prop = next((p for p in props if p.proposal_id == proposal_id), None)
            if prop is None:
                return None, None, f"unknown proposal_id: {proposal_id}"
        # Apply first; clear chat-track fields only on success.
        # Clear-before-confirm would lose the live thread + staged proposal
        # if apply_chat_result rejects (e.g. unknown branch id in removes
        # discovered after staging due to a concurrent refine).
        node_after, redirect_bid, err = self.apply_chat_result(
            sid=sid,
            node_id=node_id,
            chat_id=prop.chat_id,
            chat_summary=prop.summary,
            outcome=prop.outcome,
            ops=prop.ops,
        )
        if err is not None or node_after is None:
            return None, None, err or "apply failed"
        node.chat_messages = []
        node.pending_proposals = []
        self._persist(s)
        return node_after, redirect_bid, None

    def close_chat(
        self, sid: str, node_id: str
    ) -> tuple[Optional[Node], Optional[str]]:
        """Discard the chat thread: drop transcript + any staged proposals.
        No ChatBlock written. Non-blocking chat (ADR-0001) — there is no
        node lock or session pause to release; this is purely a "clear
        thread" operation.
        """
        s = self.sessions.get(sid)
        if not s:
            return None, "no such session"
        node = s.nodes.get(node_id)
        if not node:
            return None, "no such node"
        node.chat_messages = []
        node.pending_proposals = []
        self._persist(s)
        return node, None

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

        `resolve` outcome removed in ADR-0001 — non-blocking chat means the
        user can commit normally via `next`; chat-as-commit is dead.

        On success: appends ChatBlock. Non-blocking — no lock/pause to release.
        """
        s = self.sessions.get(sid)
        if not s:
            return None, None, "no such session"
        node = s.nodes.get(node_id)
        if not node:
            return None, None, "no such node"
        if outcome not in ("refine", "redirect"):
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

        # log the chat
        node.chats.append(
            ChatBlock(
                chat_id=chat_id,
                summary=chat_summary,
                outcome=outcome,  # type: ignore[arg-type]
                applied_at=time.time(),
            )
        )

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
        node_id = ev.grill_node_id or "_unbound"
        s.hook_traces.setdefault(node_id, []).append(ev.model_dump())
        self._persist(s)

    # ---- session-list helpers ----
    def _has_pending(self, sid: str) -> bool:
        """True when session has at least one non-implicit node not yet flushed.
        Ended sessions never count — badge fires only on active sessions
        awaiting a click."""
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
        # Enrich rows with perf log data (re-read each snapshot; matches
        # /api/sessions semantics — no in-memory cache. See ADR-0003).
        from . import performance

        perf_idx = performance.index_by_session()
        rows = []
        for s in self.sessions.values():
            entry = perf_idx.get(s.id)
            rows.append(
                {
                    "id": s.id,
                    "title": s.title,
                    "brief": s.brief,
                    "project": s.project,
                    "started_at": s.started_at,
                    "status": s.status,
                    "has_pending": self._has_pending(s.id),
                    "score": entry.score if entry else None,
                    "decision_count": entry.decision_count if entry else None,
                    "verdict": entry.verdict if entry else None,
                }
            )
        return {
            "type": "session_list",
            "session_id": "",
            "payload": {"sessions": rows},
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


def _compute_recommendation_score(node: Node) -> Optional[float]:
    """Pick-rate score for one decision node. Returns None when there's no
    signal: summary nodes, implicit decisions, multi-mode with zero
    recommended branches. See CONTEXT.md "Recommendation score"."""
    if node.kind == "summary" or node.implicit:
        return None
    by_id = {b.id: b for b in node.branches}
    removed = set(node.removed_branch_ids)
    recs = [b for b in node.branches if b.is_recommended and b.id not in removed]
    chosen_ids = list(node.chosen_branch_ids)
    # chat redirect without an explicit pick → user spec says 0.
    if node.redirected and not chosen_ids:
        return 0.0
    if not chosen_ids:
        # node hasn't been committed yet — defensive; _flush should be the
        # only caller, and it sets chosen_branch_ids in apply_action first.
        return None
    if node.multi_select:
        if not recs:
            return None
        chosen_set = set(chosen_ids)
        picked_recs = sum(1 for r in recs if r.id in chosen_set)
        return picked_recs / len(recs)
    # single-mode: 1 if any chosen id is a recommendation, else 0.
    # Synth user_authored branches are never is_recommended → 0 naturally.
    for cid in chosen_ids:
        b = by_id.get(cid)
        if b is not None and b.is_recommended:
            return 1.0
    return 0.0


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
