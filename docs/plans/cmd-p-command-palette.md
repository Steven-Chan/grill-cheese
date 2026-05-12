# Plan — Cmd+P command palette

Derived from grill session `4e56660da1bb`. See full chain in session export.

`generate_docs=true`. Doc changes ship FIRST; code references doc steps as prerequisites.

---

## Doc changes

### D1. Amend ADR-0004 — add `Cmd+P` to the keyboard layer

File: `docs/adr/0004-keyboard-interaction-model.md`

Append to "Composer — Cmd+K jump + `@`-mention chip insertion" section a new sibling section **"Command palette — `Cmd+P`"**:

- `Cmd/Ctrl+P` (window-scoped) opens the command palette overlay. Fires regardless of focus context — same pattern as `Cmd+K` / `Cmd+B`.
- `preventDefault` on the keydown swallows browser Print. Rationale: this app has no Print workflow; `GET /export/<sid>.md` is the canonical "printable artifact" path.
- Palette is **nav-only** (jump to a session or a page). No commands. Justification: every command on the toolbar / card already has a direct binding; a commands surface duplicates without discovery win.
- Items: every session in the global list + the 2 fixed pages (Session list, Performance).
- Rank: needs-you → MRU → pages → ended. MRU sourced from `localStorage.grillMru` (write on `SessionDetailPage` mount).
- Fuzzy match: title-only. `project` displayed but not matched.
- Row: title + project + status badge.
- Esc closes palette, restores focus to prior `activeElement`. See ADR-0005 for overlay precedence.

Update the **Cheatsheet** subsection: add `Cmd/Ctrl+P` row under a new "Global" group.

Update **Consequences**:
- New `gui/src/components/CommandPalette.tsx`.
- New `gui/src/mru.ts` (localStorage helper).
- `gui/src/hooks/useShortcuts.ts` gains the `Cmd+P` handler.
- App-level session-list lift (see ADR-0005 cross-ref and code step C1).

### D2. New ADR-0005 — Modal-exclusive overlay rule

File: `docs/adr/0005-modal-exclusive-overlays.md`

Sections:

- **Status:** Accepted (2026-05-12). Decided in grill session `4e56660da1bb`.
- **Context:** Three overlays existed before Cmd+P (`CheatsheetModal`, `DecisionMap`, composer `@`-popup). Each owned its own Esc handler. Adding a fourth (`CommandPalette`) forces a precedence question: stack overlays or allow only one at a time.
- **Decision:** Single overlay at a time. Opening any overlay dismisses the others. A new App-level reducer slot `activeOverlay: "palette" | "cheatsheet" | "map" | null` is the single source of truth. Each overlay component subscribes via context; on mount it calls `setOverlay("palette")` etc.; on close it clears. Esc closes the active overlay only — no precedence stack needed.
- **Tradeoffs considered:**
  - Stacked with Esc-precedence — rejected: every overlay's keydown handler must agree on order; one-off bugs become "Esc did nothing".
  - Stacked-but-block-opens — rejected: half-rule, still requires keydown coordination, no real win.
- **Self-eval (3-criteria):**
  - Hard to reverse? Medium — Esc-precedence stack would require touching each overlay's handler.
  - Surprising without context? Yes — closing cheatsheet when palette opens looks arbitrary; pinning the rule explains it.
  - Real tradeoff? Yes — stacked was a live alternative during grilling.
- **Consequences:**
  - New `gui/src/OverlayContext.tsx` with `activeOverlay` + setter.
  - `CheatsheetModal.tsx` no longer owns its open/close — `App.tsx` reads `activeOverlay === "cheatsheet"` and renders.
  - `DecisionMap.tsx` wraps its open state through the same context.
  - `CommandPalette.tsx` same.
  - `@`-popup inside Tiptap composer is **NOT** part of the rule (it's a child of the composer, not a full-screen overlay). Opening Cmd+P closes the popup transitively because the composer blurs.

### D3. CONTEXT.md seed (deferred — flag only)

CONTEXT.md does **not** exist in the repo. This grill surfaced the gap but did not fill it. Don't seed in this plan — the right time is the next grill that explicitly touches glossary. Leave a TODO comment in the new ADR-0005 referencing the gap.

---

## Code changes

All under `gui/src/`. Prerequisite: D1 + D2 merged or being merged in same commit.

### C1. App-level session list (lift state)

Prereq: D1, D2 (ADR-0005 references this lift).

- New `gui/src/AppContext.tsx`:
  - State: `{ sessions: SessionMeta[], loaded: boolean }`.
  - Effects: `listSessions()` on mount; `openSse(null, ...)` global subscription for `session_list` + `session_deleted`.
  - Provider wraps `<RouterProvider>` in `main.tsx` or `App.tsx`.
- Move `listReducer` / `initialListState` from `state.ts` if it makes sense — likely leaves them in place and `AppContext` consumes via local `useReducer`.
- `SessionListPage.tsx` switches from its own fetch + SSE to `useAppContext()`. Net deletion of ~15 lines.
- `SessionDetailPage.tsx` reads `useAppContext().sessions` for breadcrumbs/palette consumers.

### C2. MRU helper

Prereq: D1.

- New `gui/src/mru.ts`:
  - `getMru(): Record<string, number>` — reads `localStorage.grillMru`, JSON.parse, `{}` on miss/error.
  - `bumpMru(id: string): void` — read, write `{ ...prev, [id]: Date.now() }`, JSON.stringify, max 200 entries (LRU cap).
  - `rankSessions(sessions, mru): SessionMeta[]` — sort by `mru[id] ?? started_at` desc, with needs_you pinned top.
- `SessionDetailPage.tsx` calls `bumpMru(sessionId)` in a `useEffect([sessionId])`.

### C3. Overlay coordinator

Prereq: D2.

- New `gui/src/OverlayContext.tsx`:
  - State: `activeOverlay: "palette" | "cheatsheet" | "map" | null`.
  - Setter: `setOverlay(next)`.
  - Wraps `<RouterProvider>` alongside AppContext (or nested).
- Refactor `useShortcuts.ts`:
  - `onOpenCheatsheet` callback prop replaced with internal `setOverlay("cheatsheet")` call.
  - Add `Cmd/Ctrl+P` handler → `setOverlay("palette")`. preventDefault.
- `CheatsheetModal.tsx`:
  - Stop owning its open state; render is gated by `activeOverlay === "cheatsheet"` in App.tsx.
  - Esc handler calls `setOverlay(null)`.
- `DecisionMap.tsx`:
  - Same migration — show/hide via `activeOverlay === "map"`.
  - The summary-card "open map" button calls `setOverlay("map")`.

### C4. CommandPalette component

Prereq: C1, C2, C3.

- New `gui/src/components/CommandPalette.tsx`:
  - Renders when `activeOverlay === "palette"`.
  - Layout: centered overlay panel, max-width ~520px, top-positioned (15vh from top). Match `gc-cheatsheet-*` styling family — new `gc-palette-*` classes in `styles.css`.
  - Header: `<input>` with placeholder "Jump to session or page…", autofocus on mount.
  - Body: virtualized-ish flat list (≤ 200 items typical, no virtualization needed for v1).
  - Each row: `[title]  [project chip]  [status badge]`. Hover + keyboard focus highlight.
  - Items: `[...pageItems, ...rankedSessions]`. `pageItems = [{ kind: "page", to: "/", label: "Session list" }, { kind: "page", to: "/performance", label: "Performance" }]`.
  - Title-only fuzzy via inline scorer (no Fuse.js dep) — substring + char-order match, score by tighter contiguous match wins. ~30 LOC.
  - Keyboard: `↑/↓` move focus, `Enter` navigates to focused item (`navigate(to)`), `Esc` calls `setOverlay(null)`.
  - On close: restore focus to `lastFocusRef` (mirror CheatsheetModal pattern).
- App.tsx renders `<CommandPalette />` at the same level as `<CheatsheetModal />`.

### C5. Cheatsheet update

Prereq: D1.

- `CheatsheetModal.tsx`: add row under "Global" section: `{ keys: "Cmd/Ctrl + P", effect: "Open command palette" }`.

### C6. Type-check + smoke

Prereq: C1–C5 done.

- `cd gui && npm run build` — `tsc -b` must pass.
- Manual smoke (browser):
  - Cmd+P on list page → opens, focus in input, sessions ranked.
  - Cmd+P on detail page → opens, current session not pinned top (it's MRU-recent but user is already on it; OK).
  - Type partial title → list filters, top match focused.
  - Enter → navigates.
  - Esc → closes, focus restored.
  - Cmd+P while cheatsheet open → cheatsheet closes, palette opens.
  - Cmd+P inside composer (typing) → preventDefault Print, palette opens.
  - Print Cmd+P globally disabled (verify in browser; users should not see print dialog).
- Re-grill required if: palette feels slow on >100 sessions (consider virtualization), or modal-exclusive rule produces a "lost work" complaint (rare; cheatsheet has no input state).

---

## Out of scope

- Commands surface (rejected at Q1). If the user later wants `>command` mode, that's a separate grill — see Q1 chain.
- Server-side `last_viewed_at` (rejected at Q5). Move there if multi-device sync ever matters.
- `@`-popup integration with the modal-exclusive rule. Composer popup is in-flow, not an overlay; leave alone.
- Title-only restriction relax (project / brief match). Q6 rejected; revisit only if users complain about recall.
