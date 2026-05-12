# ADR-0001: Non-blocking chat — drop session pause, node lock, `chat` action, and the `resolve` outcome

## Status

Accepted (2026-05-12). Decided in grill session `f642c1efd21f`.

## Context

The original chat surface paused the whole session and locked the chatted node. The `chat` GUI action transitioned `Session.status = "paused"`, set `paused_node_id`/`paused_branch_id`, and locked the node via the action buffer's flush mechanism. Chat had to exit through one of three outcomes — `refine` / `redirect` / `resolve` — applied via `apply_chat_result`, which is what unlocked the node and resumed the session.

The lock + pause existed only so the Accept-picker (`PendingProposal` flow) could serialize cleanly: while a proposal was staged, the user couldn't also commit the question via `next`. This was infrastructure, not a domain requirement. The user can be trusted to want one or the other.

Practical cost: every chat — even a 1-line "what does X mean?" — paid a full pause + Accept-picker roundtrip. The friction killed casual chat usage. Users avoided opening chat because it felt like a commitment.

`resolve` (chat itself becomes the answer; server synthesizes a chosen branch with the chat summary as label) doubled up with the normal branch-pick commit path. Two paths to "this is the answer" made export and telemetry ambiguous.

## Decision

1. **Drop session pause.** `Session.status` enum becomes `Literal["active", "ended"]`. `paused_node_id` / `paused_branch_id` are removed from `Session`. `_status_events` / `pause_session` / `resume_session` / `_bump_status_event` are removed from `Store`. `resume_session_tool` MCP tool is removed.
2. **Drop node lock from chat.** `chat_open` survives as a "panel visible" flag only — it does NOT gate `next` / `chat_accept` / `chat_close` / Own-Answer submit. Chat can be open and the user can still commit the question.
3. **Drop the `chat` GUI action.** The composer is always-visible on every card; there is no "open chat" event. `chat_id` is lazily minted server-side on the first `chat_user_msg` per node. The literal `"chat"` is removed from `GuiAction.action` and `AskBranchesResult.action`. `TERMINAL_ACTIONS` no longer includes `"chat"`. `AskBranchesResult.chat_branch_id` / `chat_branch_label` are removed.
4. **Drop the `resolve` outcome.** `ChatOutcome` literal becomes `Literal["refine", "redirect"]`. `apply_chat_result` rejects `"resolve"`. `validate_proposals` rejects `"resolve"`. Legacy `ChatBlock` rows on disk that record `outcome="resolve"` stay readable (pydantic `extra="ignore"`); they just don't appear in new sessions.
5. **`ChatBlock.branch_id` is removed.** The only writer was `s.paused_branch_id`, which no longer exists. No reader uses it today.
6. **Telemetry adjustments.** Drop `apply_chat_result` and `resume_session_tool` from `_ALLOWLISTED_AFTER_PUSH`. Add a `chat_started` event written on the first `chat_user_msg` per node (replaces the old `chat` push event). Add a `shortcut_prefill` event written from a new `/internal/telemetry/shortcut` endpoint, fired client-side when a shortcut button is clicked.
7. **SSE shape narrows.** `session_paused` / `session_resumed` events are removed. GUI listeners drop them.

## Consequences

- The composer renders on every decision card without state-machine drift. Chat is a side-conversation.
- `state.py` shrinks: pause/resume helpers, status events, the `chat` action branch, the `resolve` branch in `apply_chat_result`. Net delete of ~80 LOC.
- GUI: BigCard layout drops the locked banner. The card stays interactive while chat is open. Refine / redirect proposals are still actionable inline, but ignorable.
- Skill no longer carries the pause/resume vocabulary or the `action == "chat"` wake handling.
- The current SKILL.md `chat_id` discipline still holds — same id across a thread, fresh id per chat panel, idempotent on retry.
- Doc-worthy terms (`Own Answer`, `Composer`, `Branch chip`, `Discussion shortcut`, `Close-match shortcut`) pinned in `CONTEXT.md`.

## Tradeoffs considered

- **Keep pause for a "deep discussion" mode.** Rejected — same friction we're removing. A non-blocking composer already lets the user type uninterrupted; an explicit deep-chat mode is feature creep.
- **Keep `resolve` as a fallback commit path.** Rejected — two commit paths to the same outcome makes export, telemetry, and the chosen-path chain walk ambiguous. The user can always commit Own Answer instead.
- **Soft-deprecate the `chat` action (warn but accept).** Rejected — the rename + always-visible composer make `chat` semantically dead. Hard-removing avoids the dual-state period where two distinct GUIs could exist.

## Self-eval

- **Hard to reverse?** Yes. Re-adding pause means restoring the state-machine edges, the `_status_events` rotation pattern, lock checks throughout `apply_action`, and the GUI banner/paused-class logic.
- **Surprising without context?** Yes. Today's code, schemas, and SKILL.md all assume pause-on-chat is canonical. `resume_session_tool` and the `paused` literal both look load-bearing to a fresh reader.
- **Real tradeoff?** Yes. Both rejected alternatives (deep-chat mode, soft-deprecate) were live options on the table during grilling.

## Migration

- Old session JSONs may carry `status="paused"`, `paused_node_id`, `paused_branch_id`, `ChatBlock.branch_id`, `outcome="resolve"`. `Session` / `Node` / `ChatBlock` pydantic models have `extra="ignore"` (or get it added) so rehydration silently drops unknown fields. Status `"paused"` falls through to default `"active"` on rehydrate.
- Old clients hitting the server with `action: "chat"` receive `400 invalid action`. The GUI is updated atomically; CC clients pinned to old skill versions will surface this on first chat click and the user can refresh.
