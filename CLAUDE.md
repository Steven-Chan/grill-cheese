# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Visual exhaustive `/grill-me` for Claude Code. Architecture is **two processes**:

- **HTTP server** (uvicorn on `127.0.0.1:7878`) — fronts the GUI (React SPA at `/` + `/sessions` + `/sessions/<sid>` via BrowserRouter with server-side fallback to `index.html`), SSE event stream (`/events`), data API under `/api/*` (`/api/actions`, `/api/sessions`, `/api/sessions/<sid>` DELETE, `/api/snapshot/<sid>`), CC hooks endpoint (`/hooks`), session export (`/export/<sid>.md`), and a JSON dispatch endpoint for the shim (`/internal/tool/<name>`). Owns all session state. Persists session JSON to `~/.grill-cheese/project-<slug>/sessions/<sid>.json`. Telemetry log at `<sid>.events.jsonl`.
- **Stdio MCP shim** (`server/shim.py`) — separate process CC spawns at session start. Re-exports the HTTP server's MCP tool surface (minus `wait_for_action` which channels replace). Forwards each tool call as plain HTTP POST to `/internal/tool/<name>`. Subscribes to `/events` SSE and emits `notifications/claude/channel` to CC via stdio when nodes flush. Required because CC's Channels feature only delivers notifications from stdio MCP subprocesses.

Why two processes: Channels is stdio-only. The HTTP server stays a single uvicorn for GUI/hooks/SSE; the shim is the CC-facing stdio bridge.

## Commands

```bash
# bootstrap
uv sync
cd gui && npm install && npm run build && cd ..

# run HTTP server (serves hooks + SSE + GUI static + /internal/tool dispatch)
uv run python -m server.server
# env: GRILL_CHEESE_HOST, GRILL_CHEESE_PORT (default 127.0.0.1:7878), LOG_LEVEL

# run stdio shim (normally CC spawns this — see claude-mcp-config.example.json)
uv run python -m server.shim

# GUI hot-reload
cd gui && npm run dev   # http://127.0.0.1:5173

# in-process smoke for the buffered grill loop
PYTHONPATH=. uv run python -m scripts.smoke_e2e

# install hooks into ~/.claude/settings.json + drop hook.js into ~/.claude/grill-cheese/
./scripts/install-hooks.sh

# install skill
cp -r skill/grill-cheese ~/.claude/skills/

# register MCP server (merge into ~/.claude.json) — stdio shim entry
cat claude-mcp-config.example.json
```

CC must launch with the channels flag until the shim is plugin-published:
```
claude --dangerously-load-development-channels server:grill-cheese
```
And CC version ≥ 2.1.80.

No pytest / lint configured. Type-check happens via `tsc -b` inside `npm run build`.

## Architecture — non-obvious parts

### Channels-mode push instead of poll (`server/shim.py` + `skill/grill-cheese/SKILL.md`)
The skill pushes one `present_branches(...)` per logical question and **ENDS THE TURN**. Channels (notifications/claude/channel) deliver the user's flushed action batch by injecting a `<channel source="grill-cheese" ...>` block into Claude's context, waking a fresh turn. No polling, no blocking waits.

The shim does the bridging: it subscribes to the HTTP server's `/events` SSE, and on every `node_committed` event emits one channel notification carrying `{session_id, node_id, seq, actions}`. The skill tracks `last_seen_seq` mentally and falls back to `get_session_snapshot` if seq jumps (snapshot-on-wake resilience for missed events).

Tool result of `present_branches` / `present_summary` includes an `instruction` field with literal `TURN_OVER. Stop generating. ...` — server-side hint to reinforce the end-turn rule.

### MCP path rewrite on the HTTP server (`server/server.py`)
CC's MCP HTTP client (used in legacy non-channels mode) POSTs to bare `/mcp` (no trailing slash). Starlette `Mount` only matches `/mcp/<...>`, so bare `/mcp` falls through to the GUI static handler → 405. Two ASGI shims fix it:
- `_McpPathFixup` rewrites `/mcp` → `/mcp/` BEFORE the router (outermost wrapper).
- `_McpRouter` strips the Mount prefix and forwards to the inner FastMCP app with path `/`.

The `/mcp` route is kept for legacy/fallback use, but the shim is the canonical path.

### Branch state machine (`server/state.py::apply_action`)
GUI actions and their server effect:

| action            | commits the buffer? | side effect |
|-------------------|---------------------|-------------|
| `next`            | yes (`chosen_branch_ids` set, plural) | picks set on node; if `own_answer` non-empty, server appends a synth `Branch(user_authored=True, label=own_answer[:60])` to `node.branches` and includes its id in `chosen_branch_ids`. Min=1: must have ≥1 branch_id OR non-empty own_answer. (Single-mode = list of length 1; multi-mode = ≥1.) |
| `stop_here` / `create_plan` / `implement_now` | yes (auto-end) | server ends session in `hooks.py:actions_endpoint` |
| `continue_grill`  | yes                          | synthesizes branch on summary node, session continues |

Inline-chat actions (`chat_user_msg` / `chat_accept` / `chat_close`) bypass the click buffer — they're handled in `hooks.py:_handle_chat_action`. Chat is non-blocking (see `docs/adr/0001-non-blocking-chat.md`): no session pause, no node lock, no `chat` action commit. Composer is always-visible; chat starts implicitly when the first `chat_user_msg` lands. Outcomes available on `apply_chat_result` / inline `proposals` are `refine` and `redirect`; `resolve` was dropped in ADR-0001.

Buffered with 750ms idle window; terminal-class clicks bypass via `flush_now`. Flush assigns a per-session monotonic `seq` and emits `node_committed` SSE → shim → channel notification.

### Snapshot-on-wake resilience (`skill/grill-cheese/SKILL.md`)
Channels are fire-and-forget. If shim dies mid-session, restarts, or the SSE ring-buffer replay re-fires already-delivered events, the skill must reconcile. Pattern: track `last_seen_seq`; if next wake's seq is not `last_seen_seq + 1`, call `get_session_snapshot(session_id)` and replay any flushed nodes you missed. The shim also buffers SSE events that arrive before its stdio session is ready (drained on session start).

### SSE pub/sub (`server/sse.py` + `server/state.py`)
Per-session channel + global channel (for the index page). Each session has a 5000-event ring buffer replayed to new subscribers. 15s heartbeat (`ping` event). Disconnect via `request.is_disconnected()`. The shim is now a long-lived consumer of this stream alongside the GUI.

### Hook → node linking (`server/hooks.py`)
CC hook script (`scripts/install-hooks.sh` writes `~/.claude/grill-cheese/hook.js`) POSTs raw hook payload to `/hooks`. The grill-cheese skill injects `_grill_node_id` / `_grill_session_id` into `tool_input` so server can attach the trace to the right decision node. Without those, traces land in `_unbound` bucket. Hook script has 1s stdin + 1s HTTP hard-kill — never blocks Claude.

### Telemetry (`server/telemetry.py`)
Per-session JSONL log at `~/.grill-cheese/project-<slug>/sessions/<sid>.events.jsonl`. Event types:
- `push` — written from `present_branches` / `present_summary`
- `next_call` — written from `internal_dispatch` for every tool call; flags `violation: true` when the gap from prior `push` is <100ms AND the tool isn't in the post-push allowlist (`apply_chat_result`, `get_session_snapshot`, `end_session`, `record_implicit_decision`, `post_chat_message`)
- `notify` — written via `/internal/telemetry/notify` POST from the shim every time it emits a channel notification
- `shortcut_prefill` — written via `/internal/telemetry/shortcut` POST from the GUI when a composer shortcut button is clicked (`explain` / `check_impl` / `compare` / `combine`)

`_last_push` in-memory map is cleared on `end_session` (and on summary auto-end in `hooks.py`) to prevent leak across many sessions.

Drives two deferred decisions:
- yield_turn() escalation if violation rate >5% over a session sample
- prompt cache TTL diagnostics (long gaps between `notify` events = blown 5min cache window)

### Frontend layout
GUI is `gui/`: React 18 + react-router-dom + react-markdown. Active surface is **single-card** — no xyflow/dagre/zustand in `BigCard`. The retrospective **decision-map** overlay (`gui/src/components/DecisionMap.tsx`) is the **sole** xyflow + dagre surface in the codebase (see `docs/adr/0002-xyflow-summary-overlay.md`); lazy-loaded from the summary card, read-only, no canvas elsewhere. Per-session state lives in `gui/src/SessionContext.tsx` (Context + `useReducer`) with reducer logic in `gui/src/state.ts`; list-page state uses a sibling `useReducer` in `gui/src/pages/SessionListPage.tsx`. SSE wiring in `gui/src/sse.ts`; types in `gui/src/types.ts`. The active question renders via `gui/src/components/BigCard.tsx`, with `SidebarHistory` for prior nodes and `FireAnimation` for the brand chrome. `node_committed` payload carries a `seq` field — keep `types.ts` in sync.

## When editing

- **Channels are stdio-only.** Don't try to add channel emit to the HTTP MCP path — it won't be delivered. The shim is the only correct place.
- **Don't reintroduce `wait_for_action`.** Skill loop is push-and-end-turn; reverting to poll defeats the latency win and breaks the seq protocol.
- **Don't add a single-call wrapper around push+wait.** Same duplicate-node bug as before. Push, end turn, channel wakes you.
- **Don't reintroduce the `chat` action, session pause, node lock from chat, or the `resolve` outcome.** All removed in `docs/adr/0001-non-blocking-chat.md`. Composer is always-visible; chat starts implicitly when the first `chat_user_msg` lands.
- **Pydantic schemas in `server/schemas.py`** are the contract for both MCP tool I/O and SSE events. Adding a field → update schema + GUI `gui/src/types.ts` + the channel payload shape in `server/shim.py:_emit_channel`.
- **Domain glossary lives in `CONTEXT.md`.** Own Answer, Composer, Branch chip, Discussion shortcut, Close-match shortcut, Non-blocking chat, Decision map. Pin new terms there first.
- **Decision map is read-only.** No `onNodeClick`, no popovers, no side panel — visual encoding (chosen/abandoned/chat-added/chat-removed/redirected) alone communicates state. If you find yourself adding interactivity, re-grill; the read-only call was an explicit user pick (ADR-0002).
- **Skill at `skill/grill-cheese/SKILL.md`** documents the channels protocol. If you change MCP tool surface or `node_committed` payload, update the skill — they're tightly coupled.
- **Sessions persist** to `~/.grill-cheese/project-<slug>/sessions/<sid>.json`. Server restart rehydrates. Telemetry .jsonl is append-only; don't truncate without reason. Legacy session JSONs with `status="paused"`, `paused_node_id`, `paused_branch_id`, `outcome="resolve"`, or `chat_open` rehydrate via `extra="ignore"` — those fields are silently dropped.
- **The shim uses `server._handle_message`** (private mcp lib API) to drive the session loop while owning the `ServerSession` handle. Will silently break if mcp lib renames the method or its signature changes; see comment in `server/shim.py:main` for context.
