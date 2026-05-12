# CONTEXT — grill-cheese domain glossary

Source of truth for terminology. Read this before edits that touch the decision-card UX or the chat/branch state machine. New terms or renames land here first, then propagate.

## Decision-card surface

- **Decision node** — a question Claude pushes to the GUI. Carries `branches`, `reasoning`, optional `parent_node_id`/`parent_branch_id` for tree wiring. Rendered as the active card.
- **Summary node** — terminal verdict card. `kind=summary`. User picks one of `stop_here` / `create_plan` / `implement_now` / `continue_grill`. Doc-flagged summaries hide `implement_now`.
- **Branch** — one Claude-proposed answer on a decision node. Has `id`, `label`, `rationale`, `is_recommended`. Synth `user_authored` branches are appended on `next` submissions that carried Own Answer text.
- **Own Answer** — the free-text commit input on a decision card. Filled when no Claude-proposed branch fits. Submitting fires `next`; server synthesizes a `user_authored` Branch from the text and includes it in `chosen_branch_ids`. NOT a "note" or branch metadata. The wire field is named `own_answer` (server schema + GUI action). Lives in the gap between branches list and action row.
- **Recommended (★)** — single-mode: one branch marked, pre-selected. Multi-mode: any subset pre-checked as the recommended set.

## Chat (inline + non-blocking)

- **Composer** — always-visible chat input on every decision card. Distinct from Own Answer. Fires `chat_user_msg`; does NOT commit the question. Hosts the shortcut button strip and the branch-chip drop target.
- **Branch chip** — composition primitive. User drags or clicks a branch row to insert a chip into the composer. Serializes inline in the message text as `[Branch <id>: <label>]`. No schema change; Claude parses the brackets on read.
- **Discussion shortcut** — composer-side button that prefills the composer with a seed template. v1 set: `Explain ▮`, `Check implementation of ▮`, `Compare ▮ and ▮`, `Combine ▮ and ▮`. `▮` slots accept chips; if left empty, the agent treats them as "this question".
- **Close-match shortcut** — per-branch "use as draft" button on each branch row. Prefills the **Own Answer** textarea with `<label> — <rationale>`. Targets the commit surface, NOT the composer. Semantically distinct from discussion shortcuts.
- **Non-blocking chat** — chat does not pause the session or lock the node. The user can still pick a branch, submit Own Answer, or trigger a verdict while chat is open. The `chat` GUI action and `Session.status=paused` are removed. Last action wins: committing the node discards any staged proposal.
- **Chat outcomes** — `refine` (mutate branches: add and/or soft-remove) and `redirect` (replace the question; node becomes read-only via a synthetic redirect branch). `resolve` is removed.
- **PendingProposal** — Claude's staged chat outcome, shown as the Accept picker. Multi-slot: a single `post_chat_message(proposals=[...])` may stage 2+ alternatives; user picks one to commit. Ignorable.

## Session lifecycle

- **Session** — top-level container. `status` is `active` or `ended` (no `paused` post-redesign). Holds nodes, hook traces, chat transcripts, and per-session `next_seq`.
- **next_seq** — monotonic per-session counter shared by `node_committed` and `chat_message_added` channel emits. Skill uses gaps to trigger `get_session_snapshot`-on-wake recovery.
- **Wrap** — toolbar action. Marks the session as awaiting a verdict card; locks pre-wrap pending nodes. Claude responds with `present_summary`.

## Eventing

- **Channel** — `notifications/claude/channel` JSON-RPC notification emitted by the stdio shim. Wakes Claude on `node_committed`, `chat_message_added` (user messages only), `chat_accepted`, and `session_wrap` events. Payload `seq` lets the skill detect gaps.
- **SSE event** — internal pub/sub between server and GUI/shim. Types: `session_started`, `session_list`, `session_ended`, `session_deleted`, `session_wrap`, `node_added`, `node_updated`, `node_committed`, `chat_message_added`, `chat_proposals_staged`, `chat_accepted`, `chat_closed`, `hook_event`, `session_meta`. (Note: `session_paused` / `session_resumed` are removed post-redesign.)
- **Hook trace** — Claude Code tool-call event POSTed to `/hooks`. Attached to a node when the skill injected `_grill_node_id` / `_grill_session_id` into `tool_input`; otherwise `_unbound` bucket.

## Implicit decisions

- **Implicit decision** — decision Claude made silently, recorded via `record_implicit_decision`. Surfaced in a separate lane. Tagged with `[CONTEXT]` / `[ADR]` prefixes when it's a doc-worthy moment.

## Ambiguities flagged

- The legacy GUI wire field `note` was overloaded — historically used as both "user's own answer" and "annotation on a branch pick". v1 of the redesign collapses this onto the new `own_answer` field. Old session JSONs may still carry `note`; the rehydrate path silently ignores unknown fields (`model_config = {"extra": "ignore"}`).
