# ADR-0006: GUI → CC bridge via server-spawned cmux panel for retro trigger

## Status

Accepted (2026-05-12). Decided in grill session `48e8e66ee4c8`.

## Context

The retrospective is triggered by a button on the `/performance` GUI page. GUI ↔ CC has no native IPC — CC sessions are user-spawned shells. Four plumbing approaches were considered: cmux shell-exec, clipboard + modal, long-running channel listener, and headless `claude -p`.

Session snapshots already capture cmux metadata (`workspace_id`, `panel_id`, `socket_path`, `bin_path`) — cmux is the user's existing CC-launching tool on this machine, and the `bin_path` is captured by the shim at session start (see `server/internal_dispatch.py` cmux header handling).

## Decision

The GUI `Run retrospective` button on `/performance` posts to `POST /api/retro` with `{project: <slug>}`. The server:

1. Reads the retro marker timestamp (`~/.grill-cheese/project-<slug>/.last-retro`).
2. Resolves the cmux bin path — scans recent session JSONs for `cmux.bin_path`, falls back to `/Applications/cmux.app/Contents/Resources/bin/cmux`.
3. Returns `{empty: true}` early if no qualifying sessions exist since the marker — GUI shows an inline toast instead of launching.
4. Otherwise shell-execs the cmux CLI to spawn a fresh panel running `claude` with the `/retro` skill invocation prefilled.
5. Returns `{panel_id, empty: false}` on success.

Slash command `/retro` typed directly in any CC terminal remains a fallback that does not depend on cmux.

## Tradeoffs considered

- **Clipboard + modal** (show "/retro" copied; user pastes). Rejected — friction; defeats the point of a button.
- **Long-running channel listener** in active CC session subscribing to a retro-trigger event. Rejected — fragile; depends on the user having an active CC session subscribed when they click.
- **Headless `claude -p`** spawned by server directly. Rejected — no user-facing terminal for the grill review surface; skill registration in headless mode is unclear.
- **cmux shell-exec** (chosen). Reuses existing integration recorded in session snapshots; gives the user a real terminal panel for the review.

## Consequences

- Soft runtime dependency: cmux must be installed for the GUI button to launch a session. If cmux is missing, the endpoint returns a 503 with a fallback message ("Run `/retro` in your CC terminal").
- New endpoint: `POST /api/retro` on the HTTP server.
- New GUI button on `/performance` (top-of-page section header).
- The exact cmux subcommand for spawning a new panel is codified in `server/retro.py` — if the cmux CLI surface shifts, this is the one place to update.

## Self-eval (3-criteria)

- **Hard to reverse?** Yes — once `/performance` ships with the button and users muscle-memorize it, swapping to slash-only is painful; cmux dependency is baked into the server endpoint.
- **Surprising without context?** Yes — the GUI normally doesn't start CC sessions; cmux as the bridge is non-obvious to a reader who's only seen the HTTP/SSE plumbing.
- **Real tradeoff?** Yes — clipboard, headless, channel-listener were all explicitly on the table and rejected.
