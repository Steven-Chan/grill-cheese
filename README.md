# grill-cheese

Visual exhaustive **grill-me** for Claude Code. Streams every decision Claude wants to grill onto a node-graph canvas; the user steers (pick a branch, type a free-text answer, chat to refine, stop). One MCP push per node; user actions delivered back via channel notifications, so the human is in the loop without holding the MCP transport open.

Inspired by [Matt Pocock's grill-me skill](https://github.com/mattpocock/skills) and the [Pail](https://arxiv.org/abs/2503.06911) research IDE.

## Architecture

```
Claude Code ──stdio MCP── server/shim.py
                              │   ▲
                    HTTP POST │   │ SSE /events
                              ▼   │
                  server/server.py (uvicorn :7878)
                  ├── /internal/tool/{name}   present_branches, present_summary, ...
                  ├── /hooks                  CC PreToolUse / PostToolUse telemetry
                  ├── /api/actions            GUI clicks
                  ├── /events                 SSE stream
                  ├── /api/sessions           list active sessions
                  ├── /api/snapshot/<sid>     JSON snapshot of a session
                  ├── /export/<sid>.md        markdown export
                  └── /  (+ /sessions/<sid>)  React SPA (BrowserRouter)
```

- **Two processes.** `server/server.py` is the long-lived HTTP server (GUI, SSE, hooks, action endpoint, JSON dispatch). `server/shim.py` is the stdio MCP subprocess Claude Code spawns; it forwards tool calls to `/internal/tool/{name}` and bridges committed actions back via `notifications/claude/channel` (CC's Channels feature is stdio-only).
- **MCP** is the spine. `present_branches(question, branches[], multi_select?)` returns immediately with a `node_id`. The user picks one branch (`action=next` with `branch_ids: [b]`), checks several in multi-mode (`branch_ids: [b1,b2,...]`), types free text (server synthesizes a `user_authored` Branch via `next + note`), pauses to chat (`action=chat`), or wraps up (`action=stop`). No long-poll — channels deliver actions push-style.
- **Hooks** are ambient: every `PreToolUse` / `PostToolUse` from Claude is POSTed to `/hooks` and rendered next to the live decision node so you see when Claude grepped vs hallucinated.
- **GUI** is a React SPA (react-router-dom). Session list at `/sessions`, per-session detail at `/sessions/<sid>` — active sessions render a focused BigCard with the pending question + a collapsible sidebar of history; ended sessions render a full linear feed. Branch states (considered / chosen / removed-via-chat), typed answers as `user_authored` branches, redirected nodes greyed, implicit decisions chipped.

## Install

Prereqs: [uv](https://docs.astral.sh/uv/), Python 3.11+, Node 18+, Claude Code CLI.

```bash
# 1. server (uv creates .venv, installs deps, writes uv.lock)
uv sync

# 2. gui
cd gui && npm install && npm run build && cd ..

# 3. start (serves GUI at :7878 + MCP + hooks)
uv run python -m server.server
```

Server now listening on `http://127.0.0.1:7878`.

## Wire into Claude Code

```bash
# install hooks (writes ~/.claude/grill-cheese/hook.js + edits ~/.claude/settings.json)
./scripts/install-hooks.sh

# install skill
mkdir -p ~/.claude/skills
cp -r skill/grill-cheese ~/.claude/skills/

# register MCP server
# merge the mcpServers block from claude-mcp-config.example.json into ~/.claude.json
# edit the "cwd" field to the absolute path of your local grill-cheese checkout
```

Then in any project (Claude Code ≥ 2.1.80 — channels flag required until the shim is plugin-published):

```bash
claude --dangerously-load-development-channels server:grill-cheese
> /grill-cheese my plan is to add billing to my SaaS using Stripe
```

Open `http://127.0.0.1:7878/` in a browser. Decisions appear as Claude generates them. Click a branch to commit it as your answer (single-select), check multiple in multi-select mode, or type free text in the always-visible textarea below the options — typed text becomes a synth `user_authored` branch on the node. Claude reads your pick + optional note (or pure note) and decides whether to drill down or move on — same flow as `/grill-me` reading a chat reply.

## Exports

- JSON: `GET /api/snapshot/<session_id>`
- Markdown: `GET /export/<session_id>.md`

## Dev

GUI hot reload separate from server:

```bash
# terminal 1
uv run python -m server.server
# terminal 2
cd gui && npm run dev   # http://127.0.0.1:5173
```

Vite proxies `/events`, `/api`, `/export` to the server. (`/internal/tool/{name}` is shim→server only; not GUI-bound.)

## Branch states

| state | meaning | how set |
|-------|---------|---------|
| considered | default | initial |
| chosen | user picked this branch (commits the node) | radio: `pick →`; multi: checkbox + `submit` |
| removed | chat outcome dropped this option | `apply_chat_result(refine, removes=[id])` |
| user_authored | synth Branch from typed text | always-visible textarea + submit |

In multi-mode (`multi_select=True`), checkboxes replace radio; ★ branches pre-checked; user submits the set in one click.

## Caveats / known seams

- Channels are stdio-only — the shim is the only place that emits `notifications/claude/channel`. CC must launch with `--dangerously-load-development-channels server:grill-cheese` (CC ≥ 2.1.80).
- Hook script is best-effort; 1s hard kill. If server is down, hooks silently no-op — Claude is unaffected.
- One global server, multiple Claude sessions. Switch in toolbar dropdown when more than one is live.

## Layout

```
server/      python: MCP tools, hooks endpoint, SSE, state
gui/         react + xyflow canvas
skill/grill-cheese/SKILL.md    instructions for Claude
scripts/install-hooks.sh       hook installer
```
