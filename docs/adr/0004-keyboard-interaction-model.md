# ADR-0004: Keyboard interaction model for the grill canvas

## Status

Accepted (2026-05-12). Decided in grill session `d6dcc569b7d1`.

## Context

The grill canvas was mouse-first. Branch picks needed a click, Own Answer needed a click-then-type, the chat composer was reachable only by clicking into it. A power-user keyboard layer was missing.

The user's brief asked for a Cmd-chord scheme — `Cmd+[num]` to pick a branch, `Cmd+Enter` to submit, `Cmd+C` to focus the composer, `Cmd+[num]` again inside the composer to drop a branch chip, `Esc` to dismiss. Direct + parallel: any branch reachable in one chord.

The cost the brief understated: on macOS Chrome (the primary target), `Cmd+1..8` switches browser tabs, `Cmd+C` is the global copy keystroke, `Cmd+W` closes the tab. `preventDefault` works at the page level but breaks user trust — when a user expects `Cmd+C` to copy text from a grill card and it silently does nothing else useful either, the keyboard layer becomes a liability.

The card also already had ARIA semantics latent in its DOM (radio inputs, labels) and an active Tiptap composer with its own `Cmd+Enter` send handler (recent commit). Building on a11y-native primitives was strictly cheaper than rolling chord interception.

## Decision

Adopt a layered model that uses native a11y primitives on the card and modifier-chords only where text input forces it (textareas).

### Branch picking — ARIA listbox + roving tabindex

- Branch row container: `role="listbox"`, `aria-multiselectable={multi_select}`, `aria-activedescendant`.
- Each branch row: `role="option"`, `aria-selected`, `tabIndex={isFocused ? 0 : -1}`.
- `↑/↓` moves focus across live branches (wrapping).
- `Space` toggles the focused branch.
- `Enter` (single-mode) picks the focused branch AND submits in one keystroke.
- `Cmd/Ctrl+Enter` (multi-mode) submits the toggled set.
- Digit `1..9` is a type-ahead: jumps focus to that branch by visible index.
- Initial focus on card render: the first ★ recommended branch (single-mode) or first ★ branch (multi-mode; first non-removed branch if none). One keystroke (`Enter`) accepts the recommendation.

### Tab order

`★ branch` → other branches (rover, single tab stop) → Own Answer textarea → chat composer.

### Composer — Cmd+K jump + `@`-mention chip insertion

- `Cmd/Ctrl+K` (window-scoped) focuses the chat composer from any context. Zero native collisions; matches the Slack / Linear / GitHub / Notion command-palette convention.
- Inside the composer: type `@` to open a numbered popup of live branches. Type `1..4` (or `↑/↓ + Enter`) to insert a branch chip (same `BranchChipNode` the drag-drop path uses; same `[Branch <id>: <label>]` serialisation).
- `Cmd/Ctrl+Enter` sends (unchanged precedent).
- `Esc` is **layered**: first `Esc` closes the `@`-popup if open and keeps composer focus + text; second `Esc` (or `Esc` when popup is already closed) blurs the editor and returns focus to the previously focused branch. Never destructive — text and chips survive blur.

### Numbering visibility

Subtle `gc-branch-hintkey` monospace badge in each branch row corner shows `1`, `2`, `3`, `4`. Always visible but visually quiet. Same index appears inside the `@`-popup, so muscle memory carries between surfaces.

### Cheatsheet

`?` (when no textarea is focused) opens a modal listing every binding grouped by surface. Toolbar footer carries a low-contrast `Press ? for shortcuts` hint.

## Tradeoffs considered

- **Cmd/Ctrl chord (user's literal brief).** Rejected. `Cmd+1..9` collides with Chrome tab-switching on macOS; `Cmd+C` collides with copy. `preventDefault` works at the page level but breaks user trust globally.
- **Alt/Option chord.** Survives Chrome tab collision but fights macOS Option+letter special-character insertion; still feels chord-y rather than a11y-native.
- **Leader key `?`-then-num (Gmail).** Zero collisions, but two keystrokes for every pick and no progressive disclosure.
- **Bare keys when not in input.** Fastest, but requires a per-focus state machine and the composer needs a different rule anyway — net more complexity than the listbox model.
- **Enter-everywhere submit.** Rejected — `Enter` inside Own Answer and composer textareas naturally inserts newlines; symmetric submit forces modifier in those surfaces, so asymmetry is unavoidable. Pushing it onto the textarea side (`Cmd/Ctrl+Enter` for text inputs) lets the card surface keep bare `Enter`.

## Self-eval (3-criteria)

- **Hard to reverse?** Yes. Once shipped, users build muscle memory; changing `Enter` vs `Cmd+Enter` semantics or swapping arrow+space for a chord mid-flight forces a re-learn. The roving-tabindex + `aria-activedescendant` wiring touches every decision card render path and the composer chip flow.
- **Surprising without context?** Yes. A fresh reader of `BigCard.tsx` will see the listbox semantics, the single-mode Enter vs multi-mode Cmd+Enter asymmetry, and the layered Esc precedence. Without this ADR each looks arbitrary; with it they fall out of one rule.
- **Real tradeoff?** Yes. The user's literal brief was Cmd-chord, and Alt-chord + leader-key + bare-keys were all live alternatives during grilling. Rejected on collision + a11y grounds; not on style.

## Consequences

- `gui/src/components/BigCard.tsx` gains listbox semantics on the branch container, roving `tabIndex`, an `onKeyDown` covering `↑/↓ / Space / Enter / Cmd+Enter / digit`, a hint-chip span per branch row, and an `Esc` handler on the editor DOM.
- New file `gui/src/hooks/useShortcuts.ts` owns the window-level `Cmd+K` and `?` bindings.
- New file `gui/src/components/CheatsheetModal.tsx` renders the binding cheatsheet.
- The Tiptap editor gains a custom suggestion plugin (via `@tiptap/pm/state`'s `Plugin` API — no new npm dep) that drives the `@`-mention popup. The popup itself is a plain React component anchored to the composer.
- `CONTEXT.md` gains `Hint chip`, `Composer-jump`, `@-mention popup` glossary entries, and a `★ initial focus` line under "Decision-card surface".
- `SidebarHistory.tsx` Esc handler is guarded so opening the cheatsheet or `@`-popup does not close the sidebar.
- No server / shim / skill protocol changes. The keyboard model is a pure GUI layer.

## Migration

None. The new keyboard layer is additive — every existing click handler stays. Drag-drop into the composer still works; the `@`-popup is the keyboard alternative, not a replacement. Old sessions rehydrate unchanged.
