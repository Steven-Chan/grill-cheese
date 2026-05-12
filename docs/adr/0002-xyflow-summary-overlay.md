# ADR-0002: Allow xyflow + dagre on the retrospective summary overlay

## Status

Accepted (2026-05-12). Decided in grill session `f11d2633fdc7`.

## Context

`CLAUDE.md` is load-bearing about the GUI's render shape:

> No xyflow/dagre/zustand — single-card UI, not a tree canvas.

That line was written to defend the *active* decision surface (`BigCard`). The grilling loop is one focused question at a time; a tree canvas there would dilute attention and reintroduce the dependency cost we deliberately rejected.

A second, *retrospective* surface now wants to exist: a "decision map" overlay on the summary card that visualises the whole grilled session — chosen branches, abandoned branches (roads not taken), chat refines/redirects, implicit decisions. Read-only, pan/zoom, no click-to-jump. Sessions can run to 15+ nodes; layout quality and viewport navigation matter for review.

Three render approaches were considered for the overlay:

- **Mermaid (`mindmap` or `graph`).** Closest to free (the GUI already ships `react-markdown`; mermaid is a single lazy import). Click callbacks exist but are awkward; pan/zoom is not native; layout quality at 15+ nodes is rough.
- **xyflow + dagre.** Purpose-built for interactive node graphs. Pan/zoom/fit-view come free. Dagre produces good top-down layouts. ~150KB lazy. Re-introduces the dependency the active surface bans.
- **Custom SVG + d3-hierarchy.** Full control, smaller footprint (~20KB), but pan/zoom and edge routing are hand-rolled work.
- **Static SVG snapshot.** Killed by the pan/zoom requirement.

## Decision

Allow `@xyflow/react` + `@dagrejs/dagre` in the GUI bundle, **scoped to the retrospective decision-map overlay only** (`gui/src/components/DecisionMap.tsx`). The active `BigCard` surface remains a single-card UI with no canvas dependencies.

Loading is lazy: `DecisionMap` is imported via `React.lazy` and only fetched when the user opens the overlay from the summary card. The xyflow bundle stays off the initial GUI payload.

## Tradeoffs considered

- **Mermaid.** Rejected. Pan/zoom and click stories are thin even if we lived with read-only, and the layout quality at 15+ nodes is noticeably worse than dagre. The bundle savings (~1MB mermaid vs ~150KB xyflow+dagre) do not justify the layout regression on the surface whose explicit goal is "skim long sessions fast".
- **Custom SVG + d3-hierarchy.** Rejected. We'd write pan/zoom, edge routing, and fit-view code that xyflow already maintains. Real engineering work for a non-load-bearing surface.
- **Static SVG snapshot.** Rejected. The user picked pan/zoom (xyflow) and read-only (no click handlers) — a static image kills pan/zoom and the goal "skim long sessions fast" goes with it.

## Self-eval (3-criteria)

- **Hard to reverse?** Yes. Adopting xyflow + dagre locks ~150KB of lazy deps and a full xyflow render component into the GUI. Swapping to mermaid later means rewriting node/edge encoding, layout, and pan/zoom configuration; swapping to custom SVG means rewriting everything.
- **Surprising without context?** Yes. The current `CLAUDE.md` line is explicit and load-bearing. A fresh reader who opens `gui/package.json` and sees `@xyflow/react` will assume drift unless this ADR is reachable.
- **Real tradeoff?** Yes. Mermaid was a live alternative — cheaper, already-adjacent (mermaid is commonly paired with `react-markdown`), and good enough for many graph-shaped visualisations. It lost on layout quality and pan/zoom, not on principle.

## Consequences

- `gui/package.json` gains `@xyflow/react` + `@dagrejs/dagre`.
- New component `gui/src/components/DecisionMap.tsx` is the sole xyflow surface. Any other use of xyflow/dagre is regression.
- `CLAUDE.md` is updated to scope the "no canvas" line to the active surface and point readers here.
- `CONTEXT.md` gains a "Retrospective surfaces" section defining **Decision map** + its visual encoding.
- Future canvas/tree-UI requests still default-deny on the active surface. Retrospective additions are case-by-case but precedented.
- The overlay is **read-only**: no `onNodeClick`, no popovers, no side panel. Visual encoding (chosen=solid, abandoned=30% opacity, chat-added=dashed green, chat-removed=strikethrough red, redirected=dashed red border) carries all the information. Reintroducing interactivity requires re-grilling — the read-only call was an explicit user pick over four alternatives.
