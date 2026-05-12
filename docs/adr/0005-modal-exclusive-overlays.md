# ADR-0005: Modal-exclusive overlay rule

## Status

Accepted (2026-05-12). Decided in grill session `4e56660da1bb`.

## Context

The GUI's full-screen overlay surfaces before this ADR:

- `CheatsheetModal` — keyboard shortcut reference, opened from `?` (ADR-0004). Capture-phase `keydown` handler swallows `Esc`.

ADR-0004 also names two adjacent surfaces that are **not** full-screen overlays — `SidebarHistory` is a docked aside, and `DecisionMap` renders in-flow inside the summary card body (`BigCard.tsx:1705`, mounted via `lazy`). Neither sits on a `position: fixed` backdrop; neither competes with cheatsheet for the primary modal slot.

Adding `CommandPalette` (ADR-0004 amendment, `Cmd+P`) introduces a second full-screen overlay. Without a rule, opening palette while cheatsheet is up — or vice versa — leaves two stacked backdrops, two competing `Esc` handlers (both registered capture-phase), and an ambiguous focus owner.

The design space has three precedents:

- **macOS / iOS modal sheets** — one at a time, opening a new one closes the prior.
- **Web stacked dialogs (react-aria, Radix Dialog primitives)** — multiple stacked, topmost owns `Esc`, focus traps stack.
- **VS Code** — Cmd+P palette dismisses other UI overlays (keybindings reference, find-in-files panel) when it opens.

## Decision

Modal-exclusive: at most one full-screen overlay is visible at a time. Opening a new one dismisses any other already open.

A single App-level slot owns the active overlay identity:

```ts
type Overlay = "palette" | "cheatsheet" | null;
```

`OverlayContext` exposes `{ active, setOverlay(next) }`. Every overlay component subscribes via the context: render is gated on `active === <its-name>`. Close calls `setOverlay(null)`. Opening any overlay just calls `setOverlay(<its-name>)` — the previously rendered overlay unmounts naturally because its render condition flips to false.

Esc handling stays local to each overlay (no precedence stack), but each handler routes through `setOverlay(null)` rather than owning its own boolean.

### Scope of the rule

In-flow components (`DecisionMap`, `SidebarHistory`) and inline popups inside form controls (composer `@`-mention popup) are **out of scope**. They are not full-screen overlays and do not own the primary modal slot. The composer `@`-popup transitively closes when Cmd+P opens because the composer blurs as palette focus arrives — no special handling needed.

If a future overlay is added (settings dialog, decision-map full-screen mode), it joins the union of `Overlay` and follows the same rule.

## Tradeoffs considered

- **Stacked with Esc-precedence.** Rejected. Adds a stack data structure to overlay state, forces every overlay's `keydown` handler to know about the stack, and produces "Esc did nothing" bug-classes when handler-registration order drifts (e.g. cheatsheet `?` rebound from inside palette would re-stack). VS Code stays modal-exclusive for the same reason.
- **Stacked-but-block-opens.** Half-rule. Existing overlay stays visible, new overlay floats on top, but Cmd+P / `?` short-circuits when another overlay is up. Still needs the coordination layer of stacked while losing its benefits.

## Self-eval (3-criteria)

- **Hard to reverse?** Medium. Switching to stacked later requires touching each overlay's Esc handler and adding a precedence stack to `OverlayContext`. Not a 1-file change but bounded.
- **Surprising without context?** Yes. A reader sees opening Cmd+P dismiss the cheatsheet and asks "is that a bug?" without this ADR pinning the rule.
- **Real tradeoff?** Yes. Both stacked variants were live during grilling, considered, and rejected on coordination cost — not on style.

## Consequences

- New `gui/src/OverlayContext.tsx` with `{ active, setOverlay }`. Provider mounts above the router outlet.
- `CheatsheetModal` no longer owns its open boolean. Render gated by `useOverlay().active === "cheatsheet"`. Esc and Close button call `setOverlay(null)`.
- `CommandPalette` follows the same pattern.
- `useShortcuts` injects `setOverlay` and replaces the prior `onOpenCheatsheet` callback prop. Cmd+P sets `"palette"`, `?` sets `"cheatsheet"`.
- `SessionDetailPage` no longer holds `cheatsheetOpen` local state; one less `useState`.
- `SessionListPage` gains the same shortcuts wiring (it previously had no `useShortcuts` mount, so `?` did not work on the list page — fixed in passing).

## Migration

None. The rule is additive — no observable change for users who only ever open one overlay at a time. Users who triggered both simultaneously (rare, no current way to do it) get the new exclusive behavior.

## Glossary gap

`CONTEXT.md` does not exist in the repo. Overlay-class surface terminology (`overlay`, `in-flow`, `OverlayContext`) is currently unpinned outside this ADR. Flagged for the next grill that touches glossary; not seeded here to keep ADR-0005 scoped to the rule itself.
