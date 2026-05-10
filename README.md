# grill-cheese

Visual exhaustive **grill-me** for Claude Code. Streams every decision Claude wants to grill onto a node-graph canvas; the user steers (pick a branch, type a free-text answer, reject, stop). Two MCP calls per node — push then long-poll — so the human is in the loop without holding the MCP transport open.

Inspired by [Matt Pocock's grill-me skill](https://github.com/mattpocock/skills) and the [Pail](https://arxiv.org/abs/2503.06911) research IDE.

## Architecture

```
            ┌─────────────────────────────────────────────┐
            │      server/server.py  (uvicorn :7878)      │
            │  ┌─────────────────┐  ┌─────────────────┐   │
Claude Code │  │ /mcp            │  │ /hooks /actions │   │
     ──MCP──┼──│ present_branches│  │  /events (SSE)  │───┼── GUI (xyflow)
   ──hooks──┼──│ wait_for_action │  │  /export/<sid>  │   │
            │  └─────────────────┘  └─────────────────┘   │
            └─────────────────────────────────────────────┘
```

- **MCP** is the spine. `present_branches(question, branches[], multi_select?)` returns immediately with a `node_id`; the **stdio shim** (`server/shim.py`) bridges committed actions back via `notifications/claude/channel`. The user picks one branch (`action=next` with `branch_ids: [b]`), checks several in multi-mode (`branch_ids: [b1,b2,...]`), types free text (server synthesizes a `user_authored` Branch via `next + note`), pauses to chat (`action=chat`), or wraps up (`action=stop`). `wait_for_action` is gone — channels deliver actions push-style.
- **Hooks** are ambient: every `PreToolUse` / `PostToolUse` from Claude is POSTed to `/hooks` and rendered next to the live decision node so you see when Claude grepped vs hallucinated.
- **GUI** is React + xyflow + dagre. Pail-aware: dim stale subtrees, branch states (considered / chosen / removed-via-chat), typed answers materialise as `user_authored` branches on the node, implicit-decision lane.

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
```

Then in any project (Claude Code ≥ 2.1.80 — channels flag required until the shim is plugin-published):

```bash
claude --dangerously-load-development-channels server:grill-cheese
> /grill-cheese my plan is to add billing to my SaaS using Stripe
```

Open `http://127.0.0.1:7878/` in a browser. Decisions appear as Claude generates them. Click a branch to commit it as your answer, hit "Other / type your answer" to override Claude's option set with free text, or use the `reject` tag to mark a branch you don't want re-surfaced. Claude reads your answer (branch + optional note, or pure note) and decides whether to drill down or move on — same flow as `/grill-me` reading a chat reply.

## Exports

- JSON: `GET /snapshot/<session_id>`
- Markdown: `GET /export/<session_id>.md`

## Dev

GUI hot reload separate from server:

```bash
# terminal 1
uv run python -m server.server
# terminal 2
cd gui && npm run dev   # http://127.0.0.1:5173
```

Vite proxies `/events`, `/actions`, `/sessions`, `/snapshot`, `/export` to the server.

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
