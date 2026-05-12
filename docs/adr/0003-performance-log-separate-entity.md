# ADR-0003: Performance log as separate entity, decoupled from session lifecycle

## Status

Accepted (2026-05-12). Decided in grill session `393ab9e1bc69`.

## Context

We record how often the user picks the agent's recommendation per decision. The per-decision score lives as a field on `DecisionNode` — computed once at the `next` commit in `apply_action`. The symmetric move for per-session aggregation would be a `recommendation_score: float | None` field on `Session`, set at session end.

That symmetry was rejected during grilling. Sessions get pruned often (the user's stated motivation for revisiting storage). If the per-session score lived on `Session`, pruning a session would also prune the score — destroying the long-term agent-vs-user alignment signal that is the entire point of this feature. Whatever survives session deletion is what counts as "performance history".

## Decision

1. Per-decision `recommendation_score` lives on `DecisionNode` (snapshot-visible, export-visible, computed at flush).
2. Per-session score lives in a **separate append-only log** at `~/.grill-cheese/performance.jsonl`. One line per ended session. Survives session JSON deletion.
3. `/api/performance` reads the log on every request — no in-memory cache, no SQLite, no daily-bucketed files. Matches the "minimal server state" preference established for `/api/sessions` enrichment.
4. Session deletion (`DELETE /api/sessions/<sid>`) removes only the session JSON. The corresponding perf log entry stays.
5. Pre-existing sessions (started before this feature shipped) get no entry; their list rows show `—` / null. Feature is forward-looking — no backfill.

## Tradeoffs considered

- **Field on Session.** Rejected — pruning sessions destroys the score history. Was the natural default until the user surfaced the prune constraint via chat refine.
- **Daily-bucketed JSONL files** (`performance/<YYYY-MM-DD>.jsonl`). Rejected — pre-bucketing in the filesystem is more plumbing than a single flat log; GUI can group client-side cheaply.
- **SQLite.** Rejected — adds a persistence dep for a workload that is append-only and scan-friendly. Future re-evaluation gate: if `read_all()` scan time becomes user-visible.
- **In-memory cache** rebuilt at boot + updated on emit. Rejected during a sub-decision — re-read on every request keeps the server stateless and matches the existing `_session_list_snapshot` pattern. Workload is small (one line per ended session).

## Consequences

- New module `server/performance.py` owns append + read.
- `/api/performance` is a new endpoint returning the flat list newest-first.
- `/api/sessions` joins perf log entries by `session_id` on every request to enrich list rows with `score`, `decision_count`, `verdict`.
- DELETE leaves the perf entry intact — perf rows can outlive their source sessions; drilldown surfaces "session pruned" gracefully.
- New GUI route `/performance` renders today's ended sessions on top + collapsed dated history below.
- `Node.recommendation_score` is `None` for: summary nodes, implicit decisions, and multi-mode nodes with zero recommended branches. Excluded from the session mean.

## Self-eval (3-criteria)

- **Hard to reverse?** Yes — once `performance.jsonl` is the canonical home and sessions are pruned, score history exists only in the log. Moving back to a Session-field model means losing every row for pruned sessions.
- **Surprising without context?** Yes — a reader who sees `recommendation_score` on `DecisionNode` will reasonably expect a symmetric field on `Session`. The split is not obvious without the pruning constraint.
- **Real tradeoff?** Yes — "Field on Session, set at end_session" was on the table and rejected via chat refine. Symmetric-with-Node was the natural default; prune-outlives-session forced the split.
