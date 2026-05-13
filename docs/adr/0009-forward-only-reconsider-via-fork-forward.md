# ADR-0007: Forward-only reconsider via fork-forward

## Status

Accepted (2026-05-13). Decided in grill session `fdc980193262`.

## Context

The grill journey is **forward-only and immutable**: once a decision node commits (`chosen_branch_ids` set), neither the node nor its branches mutate. Subsequent nodes chain forward. Chat on a committed node is non-blocking (ADR-0001) — it can `refine` (mutate branches) or `redirect` (mark node read-only via synth branch), but neither rewrites past picks.

Users have a genuine need that this surface doesn't cover: mid-session re-consideration of a past decision. Two concrete scenarios:

1. User commits a branch, immediately regrets, wants to re-discuss.
2. User answers several more questions, then realises a much earlier pick feels wrong.

No primitive exists today; the only workaround is wrap-up and start a new session, which discards all the drilling done since.

## Decision

Add a **🚩 reconsider mark** per committed-decision history row (and on the active BigCard when locked — wrap-pending or redirected). Clicking it flags the node. Claude, on its own schedule, **forks forward**: pushes a new decision node `N'` with the original question text + refreshed branches + a synth "Never mind" branch for dismissal. `N'`'s `parent_node_id` is the regretted node `N` and `parent_branch_id` is a synth "reconsider-fork edge" branch appended to `N.branches`.

The original node `N` is never mutated. Its previously-chosen branch becomes "abandoned" (reuses existing 30%-opacity decision-map encoding); downstream descendants of that branch fade in the history sidebar but remain readable.

Mark state machine: `unmarked → marked (yellow) → seen (red)`. Server flips `marked → seen` after the shim confirms the channel notification was delivered.

There is no proactive un-mark. Once 🚩 is clicked, Claude **will** re-surface (sometime between the next normal commit and `present_summary`). Dismissal happens via picking the "Never mind" branch on `N'`.

Timing: pure agent-discretion within two hard rules — never NOW (don't interrupt the current question), never past `present_summary`. Multiple marks: Claude judges ordering per-case. After `N'` commits, Claude judges per descendant which of the now-abandoned questions are still live and re-pushes only those.

Discovery: a `node_reconsider_marked` SSE event fires on mark; the shim bridges it as a `notifications/claude/channel` notification. Claude internalizes the mark and ends turn — it does NOT push any decision node on the mark-wake. The mark is acted on during the next normal commit wake.

Wrap-up with pending marks: `present_summary` proceeds but the summary card carries a "N marks unaddressed" warning. User can pick `continue_grill` to drain or proceed to a terminal verdict ignoring them. Soft enforcement.

Scope: 🚩 works on any committed decision node — regular, redirected, or itself a reconsider-fork (recursive marks allowed). Excluded: implicit-decision-lane entries, summary nodes.

## Tradeoffs considered

- **Discussion-only via chat** (no tree change). Rejected — chat already exists per-node but doesn't let the user actually change a past decision; they get clarity, no resolution.
- **Rollback + cascade invalidate** (truncate the tree at N). Rejected — directly breaks immutability + forward-only, which the user explicitly wanted to preserve.
- **Annotation-only for retro** (silent regret marker). Rejected — defers the user's in-session need to a future retro run; useless mid-grill.
- **Re-pose as next current node** (no parent link). Rejected — loses the causal anchor on the decision map; viewer can't see the fork happened.
- **Reason text required at mark time** (popover with mandatory input). Rejected — friction. Flag-only is cheaper; Claude reads chain + (optionally) chat-asks at re-surface time.
- **Per-mark "urgent" override** for timing. Rejected — user wanted pure agent-discretion; "never NOW" overrides any urgency signal.
- **Auto-replay all descendants** after `N'` commits. Rejected — forces user through obviously-settled re-decisions. Agent-judges-per-descendant chosen instead.
- **🚩 promotes implicit-decision-lane entries to grilled nodes.** Rejected — reconsider is for past **grilled** decisions; implicit-lane keeps its existing surface.
- **Marks surface in retro input.** Rejected — retro is about agent-user disagreement; reconsider is user-introspection. Different signal class.

## Consequences

- New field on `Node`: `reconsider_marked: Literal["unmarked", "marked", "seen"] = "unmarked"`.
- New field on `Session`: `reconsider_queue: list[str] = []` (ordered list of node_ids marked but not yet re-surfaced).
- New `GuiAction.action` variant: `"mark_reconsider"` (bypasses the click buffer — broadcasts immediately, terminal-class).
- New SSE event type: `node_reconsider_marked` (per-session + global).
- New channel notification kind: `node_reconsider_marked` (emitted by `shim.py`, payload `{type, session_id, node_id, reconsider_marked}`).
- New GUI primitive: 🚩 button per history row + on locked BigCard, plus a small summary-card warning chip when `reconsider_queue` is non-empty.
- Decision-map gets a 🚩 corner badge on nodes that landed via reconsider-fork; reuses the existing 30%-opacity "abandoned" semantic for the original chosen branch.
- Markdown export gains an optional `## Reconsidered` appendix listing each fork (only when forks exist).
- Skill (`skill/grill-cheese/SKILL.md`) gains a new channel-wake shape (E: `node_reconsider_marked`) with the rule that Claude internalizes silently and ends turn without pushing.
- Synth "reconsider-fork edge" branch convention: appended to `N.branches` with `rationale="reconsider-fork edge"` so the decision map + export can detect forks.

## Self-eval (3-criteria)

- **Hard to reverse?** Yes — once shipped, users rely on immutability of past nodes; switching to a mutation/rollback model later breaks the implicit contract and all decision-map encoding (which treats forks as fully-visible siblings, not hidden replays). Future contributors will assume the fork-forward semantic in any related feature.
- **Surprising without context?** Yes — a naive reader given the requirement "let user reconsider" defaults to mutating the past node, rolling back to it, or treating it as a redirect. The sibling-fork-forward via 🚩 discovery loop is non-obvious. Without the ADR, future contributors will propose mutation.
- **Real tradeoff?** Yes — alternatives genuinely considered and rejected for specific reasons (see Tradeoffs section). The chosen approach is the unique intersection of "preserves immutability" + "acts in-session" + "anchors causally on the decision map".
