---
name: retro
description: Project retrospective. Read disagreement data + chat transcripts + current doc state for the active project, narrate patterns ad hoc (no fixed taxonomy), grill the user through proposed actions one decision at a time, then apply at verdict. Trigger this skill when the user invokes `/retro` or clicks the Retrospective button on the GUI /performance page.
---

# retro

You are running a **retrospective** for the user's project. Read the disagreement signal accumulated in prior grill sessions, surface the patterns you see, and propose **concrete actions** the user can accept that will change how the agent works on this project in future.

This skill is structurally a `kind="retro"` grill-cheese session. The channel-wake protocol, end-turn discipline, and tool surface are reproduced inline below — you do not need to load the grill-cheese skill to run this one. If you happen to have both loaded, the grill-cheese SKILL.md is authoritative ONLY on the shared channel-wake protocol; the retro-specific rules in this file (start tool, action surfaces, marker semantics) take precedence on everything else.

## Channel-wake protocol (inline)

After every `present_branches` / `present_summary` call you **must end your turn**. The tool result carries `instruction = "TURN_OVER. ..."` — honor it. The grill-cheese channel wakes you with a `<channel source="grill-cheese" ...>` block in the next user message; parse the JSON inside.

Payload shapes (same as grill-cheese):
- **node-commit**: `{session_id, node_id, seq, actions: [{node_id, chosen_branch_ids, chosen_branch_labels, own_answer, action, chain_markdown?}]}`. Action is `next | stop_here | create_plan | implement_now | continue_grill`.
- **session_wrap**: `{type: "session_wrap", session_id}` — user clicked toolbar Wrap-up. Respond with `present_summary` (NOT `end_session`).
- **chat_message** / **chat_accepted**: inline chat wakes; handle per grill-cheese semantics if used during the retro.

Track `last_seen_seq` mentally — increments by 1 per wake. If the next wake's `seq` is not exactly `last_seen_seq + 1` (server restart, shim restart, dropped event), call `get_session_snapshot(session_id)`, inspect `committed_actions` on flushed nodes you haven't seen, then act on what's missing.

## When to invoke

- User types `/retro` in any CC terminal.
- User clicks **Retrospective** on the `/performance` GUI page (cmux spawns a new CC panel with `/retro <project>` prefilled — same skill, same flow).

## The retro loop

### 1. Detect project + repo root

```
git rev-parse --show-toplevel 2>/dev/null | tee /tmp/.retro-root
basename "$(cat /tmp/.retro-root)"
```

Save trimmed outputs as `repo_root` and `project`. If `repo_root` is empty (user invoked outside a git repo), fall back to `pwd` for `repo_root` and the cwd basename for `project`.

If the user passed `/retro <slug>` with an explicit project arg, prefer that over the basename.

### 2. Start the retro session

Call the dedicated MCP tool — **NOT** `start_session`:

```
start_retro_session(project=<project>, repo_root=<repo_root>)
```

Returns `{session_id, started_at, is_empty, session_count, disagreed_count, since}`. The server has already composed a markdown brief from:

- All ended sessions for this project whose `ended_at > marker_ts` (the retro marker `~/.grill-cheese/project-<slug>/.last-retro`).
- Only `kind != "retro"` sessions (retros self-exclude).
- For each disagreed node (`recommendation_score < 1`): question, branches, recommended labels, user's picks, `own_answer` text, chat transcripts, redirect / chat-removed flags.
- Current doc state: repo `CLAUDE.md` / `CONTEXT.md` / `CONTEXT-MAP.md` / `docs/adr/*.md` / `skill/*/SKILL.md`, plus `~/.claude/CLAUDE.md` and installed `~/.claude/skills/*/SKILL.md`.

The brief lives in the GUI brief banner. You also have access to it via `get_session_snapshot(session_id)`.

### 3. Handle the empty case

If `is_empty == true`: no qualifying disagreements in the window. Call `end_session(session_id)` immediately and tell the user "Nothing to retro — `<project>` has no new disagreements since `<since>`." Stop.

### 4. Read the brief and identify patterns

Call `get_session_snapshot(session_id)` once to read the structured disagreed nodes. Group them into **disagreement patterns** ad hoc: cluster by topic / surface / kind of override (the user explicitly dropped fixed categorization — narrate themes from the raw text). Multi-pattern grouping is your judgment call. A pattern can span one node or many.

For each pattern, ask: what concrete action would have made the agent suggest better next time?

**Action surfaces (only these — ADR-0005):**
1. Project docs in the repo (`CLAUDE.md`, `CONTEXT.md`, `docs/adr/*.md`).
2. Skill files under `~/.claude/skills/*` (or `skill/*/SKILL.md` in this repo).
3. Global user `~/.claude/CLAUDE.md`.
4. Source code of this app (`server/`, `gui/`, etc).

Anything else (settings.json hooks, env vars, etc) is out of bounds for v1.

### 5. Push proposal nodes — one decision per pattern

Use `present_branches(session_id, question, branches, reasoning, parent_node_id?, parent_branch_id?, depth, multi_select?)` exactly like the grill-cheese skill. **You decide the node shape per pattern** — no fixed schema:

- **Alternative-action competition** — typical case. 2-4 branches, each a different concrete action (edit X, soften rule Y, do nothing). User picks one. Use this whenever the action space genuinely has alternatives.
- **Accept/reject/refine** — degenerate case. One branch is "apply this exact change", one is "skip", one is a placeholder for chat refine. Use when the action is so specific only acceptance varies.
- **Hybrid** — N alternatives plus an explicit "skip this pattern" branch. Use when you want to surface alternatives but make the "do nothing" choice first-class.

Use `multi_select=True` when a pattern admits multiple parallel actions (rare). Default single-mode.

Each branch's `label` is the action name (≤ 6 words: "Edit CLAUDE.md: rule X"); `rationale` is one sentence — what changes, why. Mark the ★ branch you'd genuinely recommend. The node `reasoning` describes the pattern: which disagreements it covers, what the agent did, what the user did.

**Anchor each proposal node off the chain via `parent_node_id` / `parent_branch_id`** so the decision-map overlay shows the proposal sequence as one connected tree.

After each push: **END YOUR TURN**. Channel wakes you with the user's pick.

### 6. On user pick

The channel block carries `chosen_branch_ids` + `chosen_branch_labels` + optional `own_answer`. Take literally. If the user typed their own action (synth `user_authored` branch), treat that as the canonical action for the pattern.

Then either:
- Push the next proposal node for the next pattern (drill or move sideways same as grill-cheese), OR
- If patterns exhausted, call `present_summary` (see step 7).

### 7. Wrap

Call `present_summary` with a markdown recap of every accepted action. Group by action surface (project docs / skills / global / source code). For each accepted action, include: pattern it addresses, exact change proposed, file path, before/after diff sketch.

`generate_docs=False` on retro summary — retro doesn't recursively self-flag docs. Verdicts: `stop_here` / `create_plan` / `implement_now` / `continue_grill`.

### 8. On verdict

- **`stop_here`** — picks recorded in session JSON, marker updated server-side, but no files touched. Tell the user the accepted set lives in the export at `/export/<session_id>.md`.
- **`create_plan`** — write a markdown plan listing every accepted action grouped by surface. Output inline; do NOT call any file-write tool. User runs the plan separately.
- **`implement_now`** — apply every accepted action inline using `Edit` / `Write` / `Bash`. After all edits land, run any obvious validation (`uv run python -c 'import ...'` for Python edits; `npx tsc -b --noEmit` for GUI edits). Report what changed.
- **`continue_grill`** — push a fresh proposal node off the summary node's synthetic continuation branch. END TURN.

Server writes the retro marker automatically on every terminal verdict (`stop_here` / `create_plan` / `implement_now`). The next `/retro` will see only sessions ended after the moment this retro ended.

## Hard rules

- **Always start via `start_retro_session`**, never `start_session`. The dedicated tool sets `kind="retro"` and composes the brief; calling plain `start_session` skips both and breaks the dedup loop.
- **Always pass `repo_root`** (absolute path from `git rev-parse --show-toplevel`). The server uses it to read in-repo doc state.
- **Don't propose actions outside the four sanctioned surfaces.** ADR-0005 scopes the surface; out-of-bounds actions should be skipped or surfaced as ambiguities in the summary, not as proposal nodes.
- **End your turn after every `present_branches` and `present_summary`.** Channels deliver the user's action. Same discipline as grill-cheese.
- **On `implement_now`: apply edits inline.** No new handler infrastructure exists — you ARE the handler. Read files, apply changes, validate.
- **Take typed answers literally.** If the user types "actually skip this whole pattern" as Own Answer on a proposal node, skip the pattern. Don't reinterpret.
- **Patterns are your call.** Don't impose a category schema (`ui/ux/data-model/infra` was explicitly rejected by the user). Narrate themes from the raw decision text + chat transcripts.

## Boundaries vs grill-cheese

| | grill-cheese | retro |
|---|---|---|
| Session start | `start_session(title, brief, project)` | `start_retro_session(project, repo_root)` |
| Session `kind` | None | `"retro"` |
| Brief source | User-provided plan / question | Server-composed from disagreement data |
| Node content | Live decisions on user's plan | Proposed actions on patterns from prior sessions |
| Doc-state read | Skill ingests CONTEXT.md / ADRs silently | Server bundles into brief; you have it from `get_session_snapshot` |
| Marker | None | `~/.grill-cheese/project-<slug>/.last-retro` updated on terminal verdicts |

Everything else (chat, refine, redirect, decision map, summary verdicts, channel protocol) is identical.

## Export

Point the user at `http://127.0.0.1:7878/export/<session_id>.md` when the retro ends. The export carries the same chain markdown grill-cheese sessions produce — accepted actions per pattern with the picked branch labels and any Own Answer text.
