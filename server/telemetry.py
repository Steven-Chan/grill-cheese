"""Per-session JSONL event log for grill-cheese.

Path: ~/.grill-cheese/project-{slug}/sessions/{session_id}.events.jsonl

Drives two deferred decisions (see PLAN-channels-migration.md):
  * end-turn enforcement: if "next_call" arrives <100ms after "push" with
    a non-allowlisted tool, mark `violation: true`. >5% rate triggers
    yield_turn() escalation.
  * cache-miss diagnostics: gap between consecutive "notify" events is the
    user-think interval; long gaps blow the prompt cache (5min TTL).

Append-only, best-effort. Never raises into request handlers.
"""
from __future__ import annotations

import json
import pathlib
import time
from typing import Any, Optional

from .state import store


# Tool names that legitimately follow a push without violating end-turn.
# These are the only calls a turn should make AFTER present_branches /
# present_summary — chat-resume + post-session-end housekeeping.
_ALLOWLISTED_AFTER_PUSH = {
    "apply_chat_result",
    "get_session_snapshot",
    "end_session",
    "resume_session_tool",
    "record_implicit_decision",
}

VIOLATION_GAP_MS = 100.0


# session_id -> {"ts": float, "node_id": str, "tool": str}
_last_push: dict[str, dict[str, Any]] = {}


def _events_path(session_id: str) -> Optional[pathlib.Path]:
    s = store.get(session_id)
    if not s:
        return None
    proj = s.project or "_default"
    d = pathlib.Path.home() / ".grill-cheese" / f"project-{proj}" / "sessions"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception:
        return None
    return d / f"{session_id}.events.jsonl"


def _append(session_id: str, record: dict[str, Any]) -> None:
    path = _events_path(session_id)
    if path is None:
        return
    record.setdefault("ts", time.time())
    record.setdefault("session_id", session_id)
    try:
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, separators=(",", ":")) + "\n")
    except Exception:
        # Best-effort. Telemetry failure must never break the grill loop.
        pass


def log_push(session_id: str, node_id: str, tool: str) -> None:
    """Called from present_branches / present_summary."""
    ts = time.time()
    _last_push[session_id] = {"ts": ts, "node_id": node_id, "tool": tool}
    _append(session_id, {"type": "push", "tool": tool, "node_id": node_id, "ts": ts})


def log_next_call(session_id: str, tool: str) -> None:
    """Called from internal_dispatch on every incoming tool call.

    Computes gap_ms_since_push for end-turn boundary violation detection.
    """
    ts = time.time()
    last = _last_push.get(session_id)
    rec: dict[str, Any] = {"type": "next_call", "tool": tool, "ts": ts}
    if last is not None:
        gap_ms = (ts - last["ts"]) * 1000.0
        rec["gap_ms_since_push"] = round(gap_ms, 1)
        rec["after_node_id"] = last["node_id"]
        if gap_ms < VIOLATION_GAP_MS and tool not in _ALLOWLISTED_AFTER_PUSH:
            rec["violation"] = True
    _append(session_id, rec)


def log_notify(session_id: str, node_id: str, seq: int) -> None:
    """Called from the shim when emitting notifications/claude/channel."""
    _append(
        session_id,
        {"type": "notify", "node_id": node_id, "seq": seq, "ts": time.time()},
    )


def forget_session(session_id: str) -> None:
    """Drop in-memory state for a session — called on end_session.

    Without this, _last_push grows unboundedly: one entry per session id
    forever. Per session it stays constant size; across many sessions of
    a long-running server it's a slow leak.
    """
    _last_push.pop(session_id, None)
