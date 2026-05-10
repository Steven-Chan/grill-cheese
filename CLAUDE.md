# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Visual exhaustive `/grill-me` for Claude Code. One MCP server fronts three things at once:

- **MCP transport** (`/mcp/`) — tools Claude calls to push decision nodes and block on user picks.
- **Hooks endpoint** (`/hooks`) — receives every PreToolUse/PostToolUse from CC; attaches the trace to the live decision node.
- **GUI** (xyflow canvas at `/`) — React frontend; user clicks branches or types free text; SSE streams every state change.

Single uvicorn process on `127.0.0.1:7878` does all of it. GUI dist served from `gui/dist/` if built.

## Commands

```bash
# bootstrap (uv creates .venv, installs deps)
uv sync
cd gui && npm install && npm run build && cd ..

# run server (serves MCP + hooks + SSE + GUI static)
uv run python -m server.server
# env: GRILL_CHEESE_HOST, GRILL_CHEESE_PORT (default 127.0.0.1:7878), LOG_LEVEL

# GUI hot-reload (separate from server; vite proxies /events /actions /sessions /snapshot /export)
cd gui && npm run dev   # http://127.0.0.1:5173

# in-process smoke for the long-poll loop
uv run python -m scripts.smoke_e2e

# install hooks into ~/.claude/settings.json + drop hook.js into ~/.claude/grill-cheese/
./scripts/install-hooks.sh

# install skill into Claude Code
cp -r skill/grill-cheese ~/.claude/skills/

# register MCP server (merge into ~/.claude.json)
cat claude-mcp-config.example.json
```

No pytest / lint configured. Type-check happens via `tsc -b` inside `npm run build`.

## Architecture — non-obvious parts

### MCP path rewrite (`server/server.py`)
Claude Code's MCP HTTP client POSTs to bare `/mcp` (no trailing slash). Starlette `Mount` only matches `/mcp/<...>`, so bare `/mcp` falls through to the GUI static handler → 405. Fix is two ASGI shims:

- `_McpPathFixup` rewrites `/mcp` → `/mcp/` BEFORE the router runs (must be outermost wrapper, hence `app = _McpPathFixup(_inner_app)`).
- `_McpRouter` strips the Mount prefix and forwards to the inner FastMCP app with path `/` (since `streamable_http_path="/"`).

If you touch routing, keep this layering. GUI static is mounted last as catch-all `/`.

### Two-call grill loop, NOT one (`server/mcp_app.py` + `skill/grill-cheese/SKILL.md`)
CC's MCP HTTP transport has a ~60s request budget; humans take longer. So a logical "ask user" is split:

1. `present_branches(...)` → returns instantly with `{node_id}`.
2. `wait_for_action(node_id, timeout=50s)` → long-polls; returns `{action: "skip"}` on timeout. Skill MUST re-poll the same `node_id`, NOT call `present_branches` again (that duplicates the node on the canvas).

`store.set_action` is first-write-wins idempotent; `wait_for_action` returns the committed action on every subsequent call. The old single-call `ask_branches` was removed for this reason — see comment in `mcp_app.py`. Don't reintroduce a wrapper.

### Branch state machine (`server/state.py::apply_action`)
GUI actions and their server effect:

| action          | commits `wait_for_action`? | side effect |
|-----------------|----------------------------|-------------|
| `next`          | yes (`chosen_branch_id` set) | branch → `chosen`; demote prior chosen on same node |
| `other`         | yes (`note` set)             | stores `user_note` on node |
| `mark_rejected` | no (tagging only)            | branch → `rejected` |
| `unmark`        | no                           | branch → `considered` |
| `stop`          | yes                          | none |

Tagging-only actions broadcast `node_updated` so GUI re-renders, but never fire the per-node asyncio Event.

### SSE pub/sub (`server/sse.py` + `server/state.py`)
Per-session channel + global channel (for the index page that lists active sessions). Each session has a 5000-event ring buffer replayed to new subscribers. 15s heartbeat (`ping` event). Disconnect detection via `request.is_disconnected()` polled between queue gets.

### Hook → node linking (`server/hooks.py`)
CC hook script (`scripts/install-hooks.sh` writes `~/.claude/grill-cheese/hook.js`) POSTs raw hook payload to `/hooks`. The grill-cheese skill is supposed to inject `_grill_node_id` / `_grill_session_id` into `tool_input` so server can attach the trace to the right decision node. Without those, traces land in `_unbound` bucket. Hook script has 1s stdin + 1s HTTP hard-kill — never blocks Claude.

### Frontend layout
GUI is `gui/`: React 18 + xyflow + dagre + zustand. Canvas renders the full decision tree. State in `gui/src/store.ts`; SSE wiring in `gui/src/sse.ts`; layout math in `gui/src/layout.ts`.

## When editing

- Don't add a single-call wrapper around `present_branches` + `wait_for_action`. The split is load-bearing for transport-retry safety.
- Pydantic schemas in `server/schemas.py` are the contract for both MCP tool I/O and SSE events. Adding a field → update schema + GUI `gui/src/types.ts`.
- The skill at `skill/grill-cheese/SKILL.md` documents the protocol Claude must follow. If you change MCP tool surface, update the skill too — they're tightly coupled.
- Server holds all state in-process (`store` singleton in `server/state.py`); restart drops sessions. No persistence layer — don't add one without reason.
