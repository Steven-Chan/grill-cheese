# CONTEXT — grill-cheese domain glossary

Source of truth for terminology. Read this before edits that touch the decision-card UX or the chat/branch state machine. New terms or renames land here first, then propagate.

## Decision-card surface

- **Decision node** — a question Claude pushes to the GUI. Carries `branches`, `reasoning`, optional `parent_node_id`/`parent_branch_id` for tree wiring. Rendered as the active card.
- **Summary node** — terminal verdict card. `kind=summary`. User picks one of `stop_here` / `create_plan` / `implement_now` / `continue_grill`. Doc-flagged summaries hide `implement_now`.
- **Branch** — one Claude-proposed answer on a decision node. Has `id`, `label`, `rationale`, `is_recommended`. Synth `user_authored` branches are appended on `next` submissions that carried Own Answer text.
- **Own Answer** — the free-text commit input on a decision card. Filled when no Claude-proposed branch fits. Submitting fires `next`; server synthesizes a `user_authored` Branch from the text and includes it in `chosen_branch_ids`. NOT a "note" or branch metadata. The wire field is named `own_answer` (server schema + GUI action). Lives in the gap between branches list and action row.
- **Recommended (★)** — single-mode: one branch marked, pre-selected. Multi-mode: any subset pre-checked as the recommended set.
- **★ initial focus** — on render, keyboard focus lands on the recommended branch (single-mode) or the first ★ branch (multi-mode; first live branch if none). `Enter` from there picks AND submits in single-mode without any other keystroke. See ADR-0004.
- **Hint chip** — small monospace badge (`1`, `2`, `3`, `4`) in each branch row corner. Always visible but visually quiet. Doubles as the index inside the `@`-mention popup so muscle memory carries between surfaces. Distinct from Branch chip (the composer drop target).

## Keyboard model

- **Listbox semantics** — branch container is an ARIA listbox with roving tabindex. `↑/↓` moves focus, `Space` toggles, `Enter` (single-mode) picks+submits, `Cmd/Ctrl+Enter` (multi-mode) submits. Digit `1..9` is a type-ahead jump. Full spec lives in ADR-0004.
- **Composer-jump** — `Cmd/Ctrl+K` (window-scoped). Focuses the always-visible chat composer from any card surface. Picked over `Cmd+C` (collides with copy). Mirrors the Slack / Linear / GitHub / Notion command-palette convention.
- **@-mention popup** — keyboard alternative to drag-dropping a Branch chip. Type `@` inside the composer; a numbered picker of live branches opens. Type `1..4` (or `↑/↓ + Enter`) to insert a `BranchChipNode` identical to the drag-drop primitive.
- **Layered Esc** — in the composer: first `Esc` closes the `@`-popup if open and keeps text + focus; second `Esc` (or `Esc` when no popup) blurs the editor and returns focus to the prior branch. Never destructive — typed text and chips survive blur.
- **Cheatsheet (`?`)** — non-textarea keystroke opens a modal listing every binding grouped by surface. Toolbar footer carries a `Press ? for shortcuts` hint.

## Chat (inline + non-blocking)

- **Composer** — always-visible chat input on every decision card. Distinct from Own Answer. Fires `chat_user_msg`; does NOT commit the question. Hosts the shortcut button strip, the branch-chip drop target, and the `@`-mention popup. Sends on `Cmd/Ctrl+Enter` (ADR-0004).
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

## Retrospective surfaces

- **Decision map** — read-only pan/zoom canvas overlay on the summary card. Visualises the whole grilled session for review: design space (abandoned branches), shape (skim long sessions), and chat side-conversations (refines/redirects). Toggle from the summary card header; renders full-viewport. NOT a navigator — no click-to-jump, no popovers. Encoding does all the work. The sole sanctioned xyflow+dagre surface in the codebase, scoped to retrospective review (see ADR-0002).
  - **Map node** — every `DecisionNode` / summary node / implicit decision in the session. Implicit decisions render as small child nodes attached to their `parent_node_id`; doc-tagged ones (`decision` starts with `[ADR]` or `[CONTEXT]`) carry a 📍 marker.
  - **Map edge** — every entry in a parent node's `branches`. Edge label = branch label; classification follows the four-state matrix below.
  - **Map encoding** — chosen branch edge: solid full-colour. Abandoned: 30% opacity gray. Chat-added (in `pending_proposals.ops.adds` history): dashed green. Chat-removed (id in `removed_branch_ids`): strikethrough red. Redirected node (`redirected === true`): dashed red border on the node itself.

## Performance tracking

- **Recommendation score** — per-decision metric in `[0, 1]` or `null`. Single-mode: `1` if user picked the ★ branch, else `0` (Own Answer / chat redirect / any non-recommended pick → `0`). Multi-mode: `picked_recs / total_recs` (extras don't penalize). `null` when there's no signal: summary nodes, implicit decisions, multi-mode with zero recommended branches. Stored as `DecisionNode.recommendation_score`. Computed once at `next` commit in `apply_action` (`_flush`); never recomputed.
- **Session pick rate** — arithmetic mean of decision scores, skipping nulls. Computed at session end. **NOT** stored on `Session` — see ADR-0003 (sessions get pruned; per-session score must outlive them).
- **Performance log** — append-only JSONL at `~/.grill-cheese/performance.jsonl`. One line per ended session: `{session_id, project, title, ended_at, score, decision_count, verdict}`. Survives session JSON pruning. Read by `/api/performance` (flat list newest-first) and `/api/sessions` (joined to enrich list rows with `score` + `decision_count` + `verdict`). Re-read on every request — no in-memory cache.
- **Performance page** — new GUI route `/performance`. Today's ended sessions on top with per-session score; collapsed dated history (last 7 / 30 days) below.

## Session list surface

- **Needs-you bar** — sticky strip at the top of `/`. Surfaces every session with `has_pending == true` (covers both pending question AND awaiting verdict; same visual treatment, no `attention_kind` field). Sessions in this bar are pulled out of the Active section — they do NOT render twice.
- **All-clear stub** — slim persistent row inside the Needs-you bar when nothing is pending. Text: "All clear — nothing waiting on you." Keeps layout stable across flushes (no vertical jump when the last pending row clears).
- **Active section** — open sessions not waiting on you. Header + count. No sub-distinction between "running" and "idle-active" — channels-mode has no live-generation signal, and time-based freshness was rejected as noisy.
- **Ended section** — terminal sessions. Default view shows the 5 most recent; a one-way **"show all (N)"** button expands to the full list (no collapse — page reload to reset). No date sub-grouping (deferred — `/performance` already provides that view).
- **Row chrome rules** —
  - Pending `●` dot: gone (Needs-you bar replaces the signal).
  - Status chip: gone (section header carries the lifecycle).
  - `ScoreChip`: rendered only inside Ended rows.
  - Kept: title, brief preview, project chip, id-slice + relative time, delete X.
- **Project axis** — global flat list across projects. No filter, no grouping, no rail. Project chip on each row.

## Retrospective workflow

- **Retro session** — grill-cheese session whose brief is **agent-composed** from a `get_retro_input` payload (see *Retro input payload*). `Session.kind == "retro"`. Reviews proposed actions, one (or grouped) per decision node. Excluded from future retros' input windows (a retro doesn't retro itself).
- **Retro preview** — modal opened by the `/performance` Retro button. Renders counts (N disagreed nodes / M sessions / window since) + the disagreed-node questions verbatim. Cheap server-side; no LLM. Stats are advisory — the user decides whether the window is substantive enough to grill.
- **Retro input payload** — structured JSON the agent reads to compose its own brief. Server-provided via `get_retro_input(project, repo_root)` MCP tool: full disagreed nodes (question, branches, chat_messages, own_answer, recommendation_score, redirected, removed_branch_ids), doc paths, doc bodies, counts. The skill reads this payload, composes a slim user-facing brief, then calls regular `start_session(kind="retro")` with its own brief.
- **Proposal node** — decision node inside a retro session. Branches represent how to address an observed disagreement pattern. Shape is the agent's call per node: accept/reject/refine, alternative-action competition, or hybrid. No fixed schema; categorization explicitly dropped.
- **Action surface** — what a proposal can edit. Four surfaces only: project docs (repo `CLAUDE.md` / ADRs / `CONTEXT.md`), skill files (`~/.claude/skills/*`), global `~/.claude/CLAUDE.md`, source code of this app. Anything outside is out of bounds for v1.
- **Retro marker** — `~/.grill-cheese/project-<slug>/.last-retro` (text file, single ISO-8601 timestamp). Bounds the input window — retro reads only ended sessions whose `ended_at > marker_ts`. Updated on retro session end for terminal verdicts (`stop_here` / `create_plan` / `implement_now`).
- **Disagreement pattern** — agent-narrated theme aggregating multiple disagreed nodes by reading raw question + branch labels + `own_answer` text + chat transcripts. No taxonomy. Multi-pattern grouping is the agent's judgment at retro time.
- **Retro trigger** — GUI button on `/performance` first hits `GET /api/retro/preview` to fetch readiness stats + raw disagreed questions; opens a **Retro preview** modal. User decides Launch or Cancel. Launch posts to `POST /api/retro`, which shell-execs cmux to spawn a fresh CC panel running `/retro` (see ADR-0006). Slash command `/retro` works directly from any CC terminal as a fallback (bypasses the preview).

## First-run surfaces

- **Setup page** — `/setup` GUI route. Houses the Setup checklist + Invocation section. Reachable from `/sessions` empty-state nudge (when 0 sessions AND any red check) and from the Cmd+P palette (always). No toolbar link.
- **Setup checklist** — fs-probed 3-step row on /setup: skill dir, hook install, MCP entry. Each step is green/red; red steps reveal copy-paste command beneath. Probes run on mount and on `window` `visibilitychange`/`focus`. No polling, no fs watcher. No live channels-pipe verification — fs only.
- **Invocation section** — non-probed instructional block beneath the Setup checklist. Two copy-blocks (`claude --dangerously-load-development-channels server:grill-cheese`, `/grill-cheese <your plan>`) + one-sentence loop explainer. No example briefs. No demo.
- **Empty-state nudge** — variant of `/sessions` empty state shown ONLY when `totalRows === 0` AND setup detection has any red step. Short pitch + "Open setup" button → `/setup`. Otherwise empty state reverts to the existing line.

## Ambiguities flagged

- The legacy GUI wire field `note` was overloaded — historically used as both "user's own answer" and "annotation on a branch pick". v1 of the redesign collapses this onto the new `own_answer` field. Old session JSONs may still carry `note`; the rehydrate path silently ignores unknown fields (`model_config = {"extra": "ignore"}`).
- The CLAUDE.md "no xyflow/dagre/zustand — single-card UI, not a tree canvas" guidance applies to the **active** decision surface (`BigCard`) only. The retrospective **Decision map** is the lone sanctioned canvas, opted-in case-by-case via ADR (see ADR-0002).
