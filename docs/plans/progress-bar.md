# Progress bar — session-scope honest fraction

Plan for the "session progress UI" decision chain (grill session `cd0e7424632d`).

**Headline:** Thin ambient bar under the toolbar of an open session, fed by a `progress: float | None` field Claude emits on every `present_branches` / `present_summary`. Bar animates honestly (shrinks allowed). Snaps to 100% at summary; resets honestly on `continue_grill`. Absent value → indeterminate barber-pole stripe. No tooltip. Not on the session list.

`generate_docs=true` → doc changes land **before** code so future maintainers don't silently revert the "honest shrink" rule.

---

## Doc changes

### D1. New ADR: `docs/adr/0007-honest-shrink-progress-bar.md`

Status: Accepted.

Context: Grill session length is emergent. The user asked for a sense of "how far am I from done". Length is unknown by design — Claude decides depth as the user answers — so any "progress" UI must reconcile with no honest denominator.

Decision: Claude emits an optional `progress: float ∈ [0,1]` field on every `present_branches` / `present_summary` push. GUI renders a 1–2px viewport-width bar under the toolbar. New values animate in honestly — including downward (e.g. 0.6 → 0.4 when the user redirects deeper). Absent value renders an animated barber-pole stripe (distinct from 0%). `present_summary` overrides server-side to 1.0. `continue_grill` resets via the next push's estimate. No tooltip, no readout. Open-session only — session list rows render nothing.

Alternatives considered + rejected:
- **Counter only ("Question 5")** — informational, not progress.
- **Phase pill (explore / narrow / wrap)** — qualitative, no "how far" signal.
- **User-set target at start** — adds upfront friction and a guess.
- **Server tree-shape heuristic** — blind to topic; same number for "rename a var" and "design a billing system".
- **Hybrid Claude-emit + server EMA smoothing** — defeats the per-push honesty.
- **Monotonic clamp (never decrease)** — feels good, lies. Final question can land far below 100%.

3-criteria self-eval:
- Hard to reverse? **yes** — protocol field on `present_branches` + `present_summary`, persisted on `Node`, consumed by GUI bar + skill prompt. Swapping to clamp/EMA later is a coordinated schema + skill + GUI migration.
- Surprising without context? **yes** — a future maintainer will see the bar move backwards, treat it as a bug, and add a monotonic clamp. Without the ADR the honest-shrink rule will silently revert.
- Real tradeoff? **yes** — six alternatives weighed, all rejected with stated reasoning.

Consequences: Claude must remember to emit `progress` on every push. The indeterminate stripe makes the forget-rate visible to users; telemetry should log it (deferred). The bar shrinking on user redirect is a feature, not a bug — the ADR must be cited in any future PR that proposes "fixing" it.

### D2. `CONTEXT.md` edits

Append to the **Decision-card surface** section (after the **Hint chip** entry, before the **Keyboard model** heading at line 15):

- **Progress bar** — 1–2px ambient bar between the session-detail header and the body. Fed by `Node.progress: float | None`. Spans the viewport; quiet, persistent, ignorable. Distinct from `ScoreChip` (which is a per-row terminal-state badge on `/`) and from the `/performance` page (which is cross-session). Lives only inside an open session.
- **Progress estimate** — the value Claude emits on each `present_branches` / `present_summary`. Float in `[0,1]`, server-clamped. Optional; absence is a valid state (renders as Indeterminate stripe). `present_summary` overrides to `1.0` server-side. Re-estimated per push; downward changes (scope grew) animate honestly without clamp — see ADR-0007.
- **Indeterminate stripe** — the bar's render when `Node.progress is None`. Animated barber-pole. Honest "I don't know yet" state, distinct from `0%`. Never a silent last-value retention.

No edits to ambiguities or other sections.

### D3. `skill/grill-cheese/SKILL.md` edits

Two surgical edits — both anchor on existing tool documentation:

- Under the **Push the node and END YOUR TURN** step (around the `present_branches(...)` call-shape paragraph, ~line 33–36): add one sentence.
  > Pass `progress: <float in [0,1]>` — your honest estimate of how complete the session is, *after* this push lands. Re-estimate every push; downward is fine when the user redirects deeper. Absent renders as an indeterminate stripe in the GUI (visible but ugly — don't make a habit of it).
- In the **Hard rules** list: add a bullet near the "2–4 branches per node" rule:
  > **Emit `progress` on every push.** Best-guess fraction in `[0,1]`. It's optional — server accepts absence — but missing is a visible "I don't know" stripe in the GUI; treat presence as the default.
- Under the **Ending** flow (around `present_summary` semantics): add a parenthetical.
  > (No need to pass `progress` on `present_summary` — server overrides to `1.0`. Pass it if you want; it'll be ignored.)
- Update the two example `present_branches(...)` blocks to include `progress=0.2` / `progress=0.45` so the field becomes copy-paste-able muscle memory.

No new sections, no reordering.

---

## Code changes

Each step references the doc prerequisites it lands against. Steps are in build order; later steps need earlier ones merged.

### C1. Schema field on `Node` *(prereq: D1, D2)*

`server/schemas.py`, after `recommendation_score` (line 109):

```python
progress: Optional[float] = None
```

`extra="ignore"` on the model means legacy session JSONs rehydrate cleanly. No migration.

### C2. `add_node` plumbing *(prereq: C1)*

`server/state.py`, `Store.add_node` (lines 217–266):
- Add `progress: Optional[float] = None` as the final keyword arg.
- Server-side clamp: if `progress is not None`, set `progress = max(0.0, min(1.0, progress))`.
- Pass through to `Node(...)` construction.

No event-payload change needed — the existing `node_added` / `node_updated` SSE events broadcast `node.model_dump()`, so `progress` flows automatically once the field is on the model.

### C3. MCP tool signatures *(prereq: C2, D3)*

`server/mcp_app.py`:

- `present_branches` (lines 87–97): add `progress: Optional[float] = None` after `multi_select`. Forward to `store.add_node(..., progress=progress)` at the call site (line 113–123).
- `present_summary` (lines 161–168): add `progress: Optional[float] = None` after `docs_reason`, but **override to `1.0`** before forwarding — Claude's value is discarded.

  ```python
  await store.add_node(..., progress=1.0)
  ```

  Document the override in a one-line comment citing ADR-0007.

### C4. GUI type *(prereq: C1)*

`gui/src/types.ts`, `DecisionNode` interface (line 102 area):

```ts
recommendation_score?: number | null;
progress?: number | null;
```

No change to the SSE event union — `node_added` / `node_updated` already typed as `DecisionNode`.

### C5. New `ProgressBar` component *(prereq: C4, D1)*

New file `gui/src/components/ProgressBar.tsx`. Single instance, no per-node duplication.

Behaviour:
- Reads the current session's **latest committed-or-pending** node's `progress` field from `SessionContext`. "Latest" = highest `seq` on flushed nodes, falling back to the most recently added pending node.
- If `progress` is a number in `[0,1]`: render a solid fill with `width: ${progress * 100}%`. CSS `transition: width 240ms cubic-bezier(.4,.0,.2,1)` for the honest animation — works equally well for shrinks.
- If `progress` is `null` / `undefined`: render a `.indeterminate` class — full-width track with a 32px diagonally-striped foreground sliding left-to-right via a `@keyframes` rule, `2.4s linear infinite`.
- No `title` attr, no `aria-valuenow`, no tooltip. The bar is decorative-ambient; explicit `role="presentation"` to keep it out of the a11y tree (the underlying card already carries the substantive semantics).
- 1px height resting, 2px on hover via CSS hover (not JS) — purely cosmetic.

### C6. Integration in `SessionDetailPage` *(prereq: C5)*

`gui/src/pages/SessionDetailPage.tsx`: insert `<ProgressBar />` between the closing `</header>` (line 158) and the opening `<main>` (line 159). Wrap in a div positioned with negative horizontal margin to break out of the `.gc-page` padding so it spans the viewport — see the existing `.gc-needs-you-bar` precedent in `styles.css` for the layout pattern.

### C7. CSS *(prereq: C5)*

`gui/src/styles.css`: add a new block. Two rules — the static bar and the indeterminate keyframes. Reuse the existing CSS-variable palette (`--gc-accent` or similar — pick whatever the existing primary brand colour token is on inspection) so the bar follows theme changes.

```css
.gc-progress-bar { height: 1px; ... }
.gc-progress-bar__fill { background: var(--gc-accent); transition: width 240ms ... }
.gc-progress-bar.indeterminate .gc-progress-bar__fill {
  width: 100%;
  background: repeating-linear-gradient(...);
  animation: gc-progress-stripe 2.4s linear infinite;
}
@keyframes gc-progress-stripe { ... }
```

No existing keyframes to collide with (explorer confirmed none in `styles.css`).

### C8. Session list — explicit non-change

`gui/src/pages/SessionListPage.tsx`: no edit. Decision is open-session only. Worth a one-line comment near `SessionRow` to lock the call ("Progress bar is open-session only — see ADR-0007 §scope") so a drive-by PR doesn't add it.

### C9. Skill file *(prereq: D3)*

Apply D3's surgical edits to `skill/grill-cheese/SKILL.md`. Treat this as part of the same PR — skill and protocol versions move together.

---

## Build sequence

1. D1 (ADR) + D2 (CONTEXT.md) — land docs first.
2. C1 + C2 — server model + store plumbing.
3. C3 — MCP tool sigs; verify with smoke (`PYTHONPATH=. uv run python -m scripts.smoke_e2e` — should accept `progress` arg without error).
4. C4 — GUI type.
5. C5 + C7 — `ProgressBar.tsx` + CSS in one commit.
6. C6 — slot the component.
7. C8 — sanity comment on session list.
8. C9 — skill edits.
9. Manual verify: start a fresh grill session, push 3–4 nodes with varying `progress` (incl. one without, incl. one going backward); confirm the bar animates honestly, stripes when absent, snaps to 100% at summary, resets on continue_grill.

## Open / deferred

- **Telemetry on missing-field rate.** Not user-facing. A future PR can log `progress_emitted: bool` per push to the JSONL event log; if Claude forgets >X% of the time, escalate to required. Outside scope.
- **Push-1 initial value.** Implicit: it's whatever Claude emits on the first push. No special handling. Documented as such in the ADR for posterity.
- **Accessibility.** `role="presentation"` chosen deliberately. If a screen-reader user ever asks for a progress readout, revisit with `aria-valuenow`/`aria-valuetext` — but explicitly NOT now (would violate the "pure ambient, no readout" rule from the grill).
