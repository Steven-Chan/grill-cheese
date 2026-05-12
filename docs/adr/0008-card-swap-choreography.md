# ADR-0008: Layered-stack card swap choreography

## Status

Accepted (2026-05-13). Decided in grill session `15d7fba51067`.

## Context

`BigCard` renders the active `DecisionCard` / `SummaryCard` (or the read-only `gc-bigcard-pastview` when the user pins a past node) with `key={node.id}`. When a new node arrives over SSE, the old card unmounts instantly and the new one mounts instantly. No entrance, no exit, no continuity.

A two-phase **lock transition** already exists for the commit moment (phase 1: chrome fade; phase 2: chosen-row tint + FLIP reorder + rejected dim). That handles the *click → settled* feel on the same card, but does nothing for the *card → next card* hand-off — once Claude pushes the next node (seconds later, after thinking), the locked card is replaced by a hard cut.

The rest of the app uses short, eased motion (sidebar slide, progress bar tween, lock-phase). The new swap motion lives inside that vocabulary, not inventing its own.

## Decision

Layered-stack swap with directional grammar.

**Conceptual model.** Old card recedes; new card lifts in front. Stack metaphor, not cross-fade. Encoded in motion, not in persistent z-stack chrome.

**Keep-alive mechanism.** Hand-rolled CSS + two-slot render. `BigCard` lifts the pending node out of `key={node.id}` and keeps `[prev, curr]` slots. No `motion` / `framer-motion` dependency (per MIFB rule on not adding motion libraries solely for animations).

**Forward direction** (commit → next, summary verdict landing, `continue_grill` resume):
- Exit (old slot): slides OUT to the LEFT, fading.
- Enter (new slot): slides IN from the RIGHT, fading + de-blurring.

**Backward direction** (sidebar history pin, `← back to current question`):
- Same code path, opposite X signs. Exit slides RIGHT; enter comes from the LEFT.
- Convention: right-to-left = forward, left-to-right = back. Mirrors most native nav-stack metaphors (iOS push/pop, browser back/forward).

**Inner stagger.** After the card lands, semantic chunks fade-in with MIFB stagger (rule 5):
- Header (`gc-bigcard-head` / `gc-bigcard-q` / `gc-bigcard-reasoning`).
- Summary body (`gc-summary-body`) — single chunk.
- **Branches enter one-by-one.** Each `<li>` in `gc-bigcard-branches` cascades on its own delay. Exit does NOT per-row stagger — the whole list rides the card-level slide.
- Composer + actions row / summary verdicts (`gc-bigcard-actions`, `gc-composer`, `gc-summary-verdicts`, `gc-summary-continue`).

Each chunk: `opacity 0→1` + `filter blur(2px)→blur(0)`. No translateX at the inner layer — the card-level slide already carries the X motion; compounding would double-displace.

**Beat.** Sequential: exit → brief pause → enter card-slide → inner stagger tail (head, then branches one-by-one, then composer / actions).

**Timings are tuning knobs.** Specific durations, easings, and delays live in `gui/src/styles.css` (`gc-card-exit`, `gc-card-enter`, `gc-card-inner` keyframes + the `.gc-bigcard-slot.entering …` delay groups). This ADR deliberately omits numbers — they will be tuned over time and the doc would rot. The single source of truth is the CSS; `BigCard.tsx`'s `SWAP_TOTAL_MS` constant is the only JS-side mirror and carries a comment pointing back to the CSS.

**Reduced motion.** `@media (prefers-reduced-motion: reduce)` collapses to instant cut. No transitions, no stagger, no Y/blur. Prev slot hides via `display: none`. No halfway "slower-and-shorter" state — vestibular sensitivity is about translation/scale, not duration.

**First render.** Skip entrance on the first BigCard mount per session (page reload, cmd+P swap, hard nav). `useRef(true)` flag in BigCard; first node renders in final state; ref flips false; subsequent swaps animate. Per MIFB rule 13.

**Coordination with lock transition.** Untouched. The 180+280ms lock-phase runs on the still-mounted old card BEFORE the swap starts. When the new node arrives seconds later, the locked card begins exiting while preserving phase-2 visuals (chosen tint + rejected dim). Two distinct beats; they don't fuse.

## Alternatives considered

- **Cross-fade only.** Simpler, content-first, MIFB-aligned. Rejected for lacking the depth metaphor the user explicitly wanted.
- **Forward-motion (direction-aware drill vs sideways vs redirect).** Encodes tree-walk semantics in motion. Rejected: motion noise per swap, fragile direction detection in the reducer.
- **Morph (locked chosen row → next question region).** Smooth visual continuity. Rejected: couples two unrelated nodes; fragile when branch counts or layouts differ.
- **Add `motion/react` (Framer Motion).** Clean `AnimatePresence` lifecycle. Rejected: ~30kb gzipped; MIFB advises against adding motion libraries solely for animations.
- **Overlap (cross-dissolve) vs sequential.** Concurrent exit+enter is more compact (~300ms total) but reads as a quick wash. Sequential (510ms+) gives a clearer "this is done, here's next" narrative.
- **Recede by scale + blur** vs translateY-down. Scale gives more literal depth but risks subpixel artefacts and conflicts with the existing FLIP reorder during lock-phase 2. Y-axis is cleaner.
- **Reduced-motion = halved durations / amplitudes.** Rejected: misreads the spec — `prefers-reduced-motion` is about removing translation, not slowing it.

## Consequences

- The forward/back directional grammar is now part of the surface's language. Any future card-swap surface inherits it; reviewers reading the asymmetric CSS need to know the convention is deliberate.
- `BigCard` mount lifecycle changes: no longer a single `key={node.id}` swap, now `[prev, curr]` slot reducer. Any test or downstream that asserts single-card mount needs updating (currently none).
- History-pin swap (`gc-bigcard-pastview` ↔ active) routes through the same two-slot path with the backward direction. Previously instant.
- Lock-phase CSS is untouched — the new transition runs on top, not in place of it.
- No new dependency. Pure CSS transitions + ~40 lines of React state in BigCard.

## Self-eval

- **Hard to reverse?** Yes — once users learn the forward/back grammar, changing it forces a relearn and contradicts the documented convention.
- **Surprising without context?** Yes — a reader sees `gc-bigcard-slot.entering.back` with opposite-sign transforms and the `isFirstSwapRef` and won't know it's deliberate (could "simplify" to a single direction).
- **Real tradeoff?** Yes — four conceptual models, three beat options, three reduced-motion strategies, two geometry families, two library choices all considered and explicitly rejected during the grill.
