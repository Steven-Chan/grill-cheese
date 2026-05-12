# Plan — BigCard layered-stack swap transition

Implements decisions from grill session `15d7fba51067`. Doc changes land first; code changes reference them as prerequisites.

## Doc changes

Both required before any code lands. Doc edits encode the directional grammar (down=forward, up=back) and the choreography contract — every reader of the CSS/TSX needs the convention spelled out, else "simplify the asymmetry" becomes an obvious-looking refactor.

### D1. `CONTEXT.md` — add **Card swap** glossary entry

Insert under **Decision-card surface**, alongside "Decision node" / "Summary node":

> **Card swap** — animated transition between BigCard surfaces. Layered-stack metaphor with directional grammar: **forward** (commit → next, summary verdict, continue_grill resume) = old card sinks DOWN, new card lifts UP from below; **backward** (sidebar history pin, "← back to current question") = old card lifts UP, new card sinks IN from above. Sequential beat: exit (150ms ease-in) → 60ms pause → enter (300ms `cubic-bezier(0.2, 0, 0, 1)` + inner stagger). Reduced-motion collapses to an instant cut. First BigCard mount on a session (page reload, cmd+P swap) renders the active node in its final state without animation; only subsequent swaps animate. Distinct from the **lock transition** (commit-moment phase 1+2), which runs on the old card BEFORE the swap begins and is preserved through the sink.

No other CONTEXT.md edits — existing terms (Decision node, Summary node, Lock transition implicit in BigCard description) are untouched.

### D2. New `docs/adr/0008-card-swap-choreography.md`

Format follows ADR-0007 (Status / Context / Decision / Alternatives / Consequences). Skeleton:

```
# ADR-0008: Layered-stack card swap choreography

## Status
Accepted (2026-05-13). Decided in grill session `15d7fba51067`.

## Context
BigCard renders the active DecisionCard / SummaryCard with `key={node.id}` —
when a new node arrives, the old card unmounts instantly and the new one
mounts instantly. No entrance, no exit. The existing two-phase lock
transition (180ms chrome fade + 280ms FLIP reorder) handles the commit
moment but not the card-to-card hand-off.

## Decision
[Summarise: layered-stack model, hand-rolled CSS two-slot, translateY-down
exit + lift-up enter, inner stagger, sequential beat, reduced-motion =
instant cut, skip-on-first-render, history-pin reverses direction.]

## Alternatives considered
- Cross-fade only — simpler, but no depth metaphor.
- Forward-motion (direction-aware by drill/sideways) — encoded tree-walk
  semantics in motion; rejected as motion-noise.
- Morph (locked row → next question region) — coupled two unrelated
  nodes; fragile on layout shift.
- Add motion/react — extra ~30kb dep; MIFB rule says don't add motion
  libs just for animations.
- Overlap (cross-dissolve) vs sequential — chose sequential for clearer
  "this is done, here's next" narrative.

## Consequences
- The forward/back directional grammar is now part of the surface's
  language. Future card-swap surfaces (if any) inherit it.
- Existing `lock-phase` CSS is untouched; the new transition runs on the
  old card AFTER phase 2 settles. The two beats don't fuse.
- `BigCard` lifts the pending node out of `key={node.id}` and tracks
  `[exiting, entering]` slots. The mount lifecycle changes; tests that
  assert single-card mount need updating.
- History-pin swap (pastview ↔ active) now uses the same two-slot path
  with reversed transforms.

## Self-eval
- hard to reverse? yes — users learn the convention; changing it forces relearn.
- surprising without context? yes — reader sees asymmetric forward/back
  transforms and the isFirstSwap ref; ADR explains the intent.
- real tradeoff? yes — four conceptual models, three beat options, three
  reduced-motion strategies all considered and explicitly rejected.
```

## Code changes

All prerequisites: D1 + D2 merged. Code does **not** start before docs land — the directional grammar is the spec.

### C1. `gui/src/components/BigCard.tsx` — two-slot render + direction tracking

Refactor the BigCard render to support concurrent old+new cards.

1. **Hoist the pending-node resolution** (lines ~77-90) into a `useMemo` returning `{nodeId, kind, fromFallback}`.
2. **Add slot state**: `useState<{prev: Slot | null; curr: Slot}>`. A `Slot` is `{nodeId, kind, mountedAt: number}`. On `nodeId` change: move current → prev (mark exiting), set curr to new (mark entering).
3. **Direction**: compute `direction: "forward" | "back"` per swap:
   - If swap is `selectedNodeId === null → !== null` OR vice-versa: backward (entering/leaving pastview).
   - Else: forward (active session progression).
   - Initial mount: no animation (see C2).
4. **Render both slots** when `prev != null`, each wrapped in:
   ```tsx
   <div className={`gc-bigcard-slot ${slotState}`} data-dir={direction}>
     {/* existing DecisionCard / SummaryCard / pastview */}
   </div>
   ```
   `slotState` is `exiting` or `entering`. Forward direction = no extra class; backward = adds `back` class (CSS flips transform signs).
5. **Cleanup**: on exit-animation end (`onTransitionEnd` listening for `opacity`), drop `prev` from state. Fallback timer (~250ms) to guarantee cleanup if `transitionend` doesn't fire.
6. **History-pin path** (lines 54-70): the early-return for `gc-bigcard-pastview` now also routes through the slot system so the pastview ↔ active swap animates with the back direction.

### C2. `gui/src/components/BigCard.tsx` — first-render skip

Add `isFirstSwapRef = useRef(true)`. On the first slot-state transition, do NOT apply the entering animation — render the curr slot in final state. Flip the ref to false. All subsequent swaps animate.

This must work across:
- session-start (first node arriving over SSE — handled by always rendering curr without `entering` class on first mount)
- page reload (snapshot rehydrates, pending node already exists at mount — same)
- cmd+P session swap (SessionProvider remounts BigCard, isFirstSwapRef re-init → same)

### C3. `gui/src/styles.css` — slot transitions

Add new block after the existing `.gc-bigcard` rules (~line 549). Use CSS transitions (not keyframes — MIFB rule on interruptibility). Specific properties only, never `transition: all`.

```css
.gc-bigcard-slot {
  /* slot wraps DecisionCard/SummaryCard; provides positioning context
     so prev + curr can stack via grid-area or absolute */
}

/* Forward direction (default) */
.gc-bigcard-slot.exiting {
  opacity: 0;
  transform: translateY(24px);
  transition: opacity 150ms ease-in, transform 150ms ease-in;
  pointer-events: none;
}
.gc-bigcard-slot.entering {
  /* initial state — JS toggles to settled via class flip after RAF */
  opacity: 0;
  transform: translateY(16px);
  filter: blur(4px);
  transition: opacity 300ms cubic-bezier(0.2, 0, 0, 1) 210ms,
              transform 300ms cubic-bezier(0.2, 0, 0, 1) 210ms,
              filter 300ms cubic-bezier(0.2, 0, 0, 1) 210ms;
  /* delay 210ms = 150ms exit + 60ms pause */
}
.gc-bigcard-slot.entering.settled {
  opacity: 1;
  transform: translateY(0);
  filter: blur(0);
}

/* Backward direction (sidebar history pin) — opposite signs on Y */
.gc-bigcard-slot.exiting.back { transform: translateY(-16px); }
.gc-bigcard-slot.entering.back { transform: translateY(-16px); }
.gc-bigcard-slot.entering.back.settled { transform: translateY(0); }
```

### C4. `gui/src/styles.css` — inner stagger

Inner chunks (header / branches / composer / actions) need staggered entrance after the card lands. Add classes on `DecisionCard` / `SummaryCard` children:

- `.gc-bigcard-head` — delay 0ms
- `.gc-branches` (the `<ul>`) — delay 100ms
- `.gc-bigcard-actions` and composer wrapper — delay 200ms

```css
.gc-bigcard-slot.entering .gc-bigcard-head,
.gc-bigcard-slot.entering .gc-branches,
.gc-bigcard-slot.entering .gc-bigcard-actions,
.gc-bigcard-slot.entering .gc-bigcard-composer-wrap {
  opacity: 0;
  transform: translateY(8px);
  filter: blur(2px);
  transition: opacity 240ms ease-out, transform 240ms ease-out, filter 240ms ease-out;
}
.gc-bigcard-slot.entering.settled .gc-bigcard-head { transition-delay: 210ms; opacity: 1; transform: none; filter: none; }
.gc-bigcard-slot.entering.settled .gc-branches { transition-delay: 310ms; opacity: 1; transform: none; filter: none; }
.gc-bigcard-slot.entering.settled .gc-bigcard-actions,
.gc-bigcard-slot.entering.settled .gc-bigcard-composer-wrap { transition-delay: 410ms; opacity: 1; transform: none; filter: none; }
```

Verify the composer wrapper class name in BigCard.tsx — if it differs, update the selector accordingly.

### C5. `gui/src/styles.css` — extend reduced-motion block

Extend the existing `@media (prefers-reduced-motion: reduce)` block (line 635) to neutralise the new transitions:

```css
@media (prefers-reduced-motion: reduce) {
  /* existing rules retained */
  .gc-bigcard-slot.exiting,
  .gc-bigcard-slot.entering,
  .gc-bigcard-slot.entering .gc-bigcard-head,
  .gc-bigcard-slot.entering .gc-branches,
  .gc-bigcard-slot.entering .gc-bigcard-actions,
  .gc-bigcard-slot.entering .gc-bigcard-composer-wrap {
    transition: none;
    opacity: 1;
    transform: none;
    filter: none;
  }
  .gc-bigcard-slot.exiting { display: none; }
}
```

The `.exiting { display: none }` is the simplest way to achieve "instant swap" — prev slot vanishes immediately rather than ghosting for 250ms.

### C6. Smoke test

Three flows to verify by hand in the GUI (no automated test — this is visual):

1. **Forward swap**: start session, answer Q1 → observe lock-phase commit, then on next node arrival, old sinks down + new lifts up with inner stagger.
2. **Backward swap**: from active card, click a past entry in SidebarHistory → observe reverse direction (active lifts up, pinned drops in from above). Click "← back to current question" → forward direction back.
3. **Reduced motion**: enable system preference, repeat (1) and (2) → both should be instant cuts.

If any chunk's transform/filter feels off, the only knobs are duration / delay / Y amplitude — keep blur 4px and opacity 0→1 fixed per MIFB rule 7.

## Ordering

1. Land D1 + D2 (one commit, doc-only).
2. Land C1 + C2 (one commit, TSX-only refactor — render still looks the same because slot states are inert without C3).
3. Land C3 + C4 + C5 (one commit, CSS).
4. Smoke test C6, tune amplitudes if needed.

Steps 2 and 3 can be a single commit if reviewer prefers; keeping them split makes the diff easier to read.
