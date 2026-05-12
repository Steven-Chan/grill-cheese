# ADR-0007: Honest-shrink session progress bar

## Status

Accepted (2026-05-12). Decided in grill session `cd0e7424632d`.

## Context

A grill session can be short (3 questions) or long (15+). The user has no
denominator: Claude decides depth as the user answers, so total question count
is emergent. The user asked for a sense of "how far am I from done" without
which long sessions feel open-ended.

Six approaches were considered:

1. **Counter only** (`Question 5`, no total). Informational, not progress.
2. **Phase pill** (`exploring` / `narrowing` / `wrapping`). Qualitative, no
   "how far" signal.
3. **User-set target at start** (short / medium / deep ≈ 3/7/15). Upfront
   friction; requires a guess.
4. **Server tree-shape heuristic** (depth / typical branching). Blind to
   topic — same number for "rename a var" and "design a billing system".
5. **Hybrid Claude-emit + server EMA smoothing**. Defeats the per-push
   honesty; hides genuine scope changes under client-side averaging.
6. **Monotonic clamp** (bar never decreases). Feels good, lies. Final question
   can land far below the asserted 100%.

## Decision

Claude emits an optional `progress: float ∈ [0,1]` field on every
`present_branches` and `present_summary` push. The GUI renders a 1–2px
viewport-width bar between the session-detail header and the body — quiet,
ambient, persistent.

New values animate to the bar's `width` via a single CSS transition, in **both
directions**: if Claude re-estimates downward (e.g. user redirects deeper and
scope grows from 0.6 → 0.4), the bar **shrinks**. No monotonic clamp. No
client-side EMA. Honest re-estimation > pleasant lie.

`present_summary` overrides Claude's value server-side to `1.0`. The
`continue_grill` verdict resets honestly via the next `present_branches`
push's estimate (e.g. back to 0.7).

When `progress` is absent the bar renders an animated **barber-pole stripe**
— distinct from `0%`, distinct from a real value. Visible "I don't know yet"
state. No silent last-value retention.

No tooltip. No `%` on hover. No `~3 more questions` readout anywhere. The
bar IS the headline; fullness is the only signal. The bar lives **inside an
open session only** — session list rows (`/`) render nothing.

## 3-criteria self-eval

- **Hard to reverse?** **Yes** — protocol field added to `present_branches`
  and `present_summary`, persisted on `Node`, consumed by GUI + skill prompt.
  Swapping to monotonic clamp / EMA / heuristic later is a coordinated
  schema + skill + GUI migration.
- **Surprising without context?** **Yes** — a future maintainer will see the
  bar move backwards, treat it as a bug, and add a monotonic clamp. Without
  this ADR the honest-shrink rule will silently revert.
- **Real tradeoff?** **Yes** — six alternatives weighed, all rejected with
  stated reasoning.

## Consequences

- Claude must remember to emit `progress` on every push. The indeterminate
  stripe makes the forget-rate visible to users (and a future telemetry
  surface can quantify it).
- The bar shrinking on a user redirect is a **feature**, not a bug. Cite
  this ADR in any PR that proposes "fixing" it.
- Session JSONs gain one optional float per node. Negligible disk cost; no
  migration (Pydantic `extra="ignore"` already silently handles legacy
  rehydrate without the field).
- The bar carries `role="presentation"` and no `aria-valuenow`. It is
  decorative-ambient; the underlying card already carries the substantive
  semantics. If a screen-reader user ever requests a progress readout,
  revisit — but explicitly NOT now (would violate the "pure ambient, no
  readout" rule from the grill).
