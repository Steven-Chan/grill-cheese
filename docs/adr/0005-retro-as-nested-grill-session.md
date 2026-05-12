# ADR-0005: Retrospective implemented as a nested grill-cheese session

## Status

Accepted (2026-05-12). Decided in grill session `48e8e66ee4c8`.

## Context

The retrospective surface reviews per-decision disagreements between user and agent (`recommendation_score < 1` nodes, `own_answer` text, chat-redirect outcomes) and proposes concrete actions across four action surfaces: project docs (repo `CLAUDE.md` / ADRs / `CONTEXT.md`), skill files (`~/.claude/skills/*`), global `~/.claude/CLAUDE.md`, and source code of this app.

Four review-surface candidates were considered: markdown-in-CC, grill-cheese decision nodes, staged file with checkboxes, auto-PR. The decision-card surface is the project's existing review primitive — chat, refine, decision map, summary verdict are already wired.

## Decision

Each retro run starts a `kind="retro"` grill-cheese session. The session is initiated by the **retro skill** (the agent) calling the regular `start_session(title, brief, project, kind="retro")` MCP tool — the agent composes the brief itself after reading a structured `get_retro_input(project, repo_root)` payload from the server. Server responsibility is bounded to providing raw structured data (counts, disagreed-node detail, doc bodies); the agent decides what the user-facing brief actually says. See `## Revisions` at the bottom of this ADR.

Proposals render as ordinary decision nodes; the agent decides per-node shape (accept/reject/refine vs alternative-action competition vs hybrid) at retro time — no fixed schema is imposed.

Retro session verdicts use the standard four-button surface (`stop_here` / `create_plan` / `implement_now` / `continue_grill`). `implement_now` invokes the agent's existing file tools (`Edit` / `Write` / `Bash`) inline; no new per-proposal handler infrastructure.

Retro sessions carry `Session.kind == "retro"` so they self-exclude from future retros' input windows (a retro doesn't retro itself).

## Tradeoffs considered

- **Markdown list in CC, user replies "accept #N".** Rejected — no per-proposal refine chat, no decision-map artifact, lives only in CC transcript.
- **Staged file at `.grill-cheese/proposals.md`.** Rejected — loses interactive refine; user has to context-switch between editor and CC.
- **Auto-PR with all changes batched.** Rejected — heavy plumbing; can't handle skill install / global CLAUDE.md edits (those aren't in the repo).
- **Each proposal as a decision node** (chosen). Reuses every existing primitive. Risk: feels recursive (grill-cheese reviewing grill-cheese sessions) — accepted as the cost of full reuse.

## Consequences

- New optional field on `Session`: `kind: Optional[str] = None`. Existing sessions stay None (regular grill); retros set `"retro"`.
- `start_session` MCP tool gains an optional `kind` parameter (default `None`).
- Two server data surfaces, sharing collection logic in `server/retro.py`:
  - HTTP `GET /api/retro/preview?project=<slug>` — modal-shaped (counts + disagreed-node questions only; skips doc bodies).
  - MCP `get_retro_input(project, repo_root)` — agent-shaped (full disagreed-node detail + doc bodies + counts + `is_empty`).
- `start_retro_session` MCP tool and `compose_brief` / `_render_brief_markdown` markdown rendering retired — agent owns user-facing composition.
- Retro's input scan (in `server/retro.py::collect_disagreement_data`) filters out sessions where `kind == "retro"`.
- Decision-map overlay on retro summary cards renders the same as regular sessions — no new visual encoding.
- Retro session export markdown is reachable at the same `/export/<sid>.md` route.

## Self-eval (3-criteria)

- **Hard to reverse?** Yes — once shipped, semantics will be baked into the skill + GUI button + cmux bridge; rolling back to markdown-in-CC means removing the `kind` field, the skill, the endpoint, and re-wiring user muscle memory.
- **Surprising without context?** Yes — recursion (grill-cheese reviewing grill-cheese sessions); a reader will assume retro is a separate dashboard or a CLI tool, not a nested grill.
- **Real tradeoff?** Yes — markdown-in-CC, staged-file, PR-based all considered during the grill and explicitly rejected.

## Revisions

### 2026-05-12 — agent-composed brief

Original Decision (as merged in commit `ba0df27`) made `start_retro_session` compose a markdown brief on the server and pass it as `Session.brief`. User feedback within the same day flagged that brief as too heavy to read.

Reversed in grill session `66ee4f1fc247`:
- Server stops pre-rendering markdown. New `get_retro_input(project, repo_root)` MCP tool returns a structured payload.
- Skill reads payload → composes slim brief → calls regular `start_session(kind="retro")` with its own brief.
- New `GET /api/retro/preview` endpoint feeds a Retro preview modal on `/performance` (separate concern from the agent brief — modal is the user's pre-launch readiness check).
- `start_retro_session`, `compose_brief`, `_render_brief_markdown` retire.

Why no ADR-0007 superseder: the original is one hour old, the scope is bounded (~150 LOC), and a Revisions section is more discoverable than a separate ADR that supersedes a fresh one.
