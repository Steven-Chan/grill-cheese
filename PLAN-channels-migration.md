# Plan — Channels migration (push-based wake)

Source: grill session `2457f15c3aa1` (2026-05-10). User picked `create_plan` from summary verdict.

## TL;DR

Replace blocking `wait_for_action` long-poll with CC Channels-pushed notifications so Claude wakes on user click instead of polling. Smaller, faster, no idle Claude turns.

**Spike result lands BEFORE coding starts**: Channels are **stdio-only**. Cannot run over the existing HTTP MCP transport. The optimistic "verify HTTP works first" path from the grill is closed. Forces an architectural shim — see "Critical revision" below.

## Goal

- Eliminate ~tens-of-seconds Claude per-turn latency caused by blocking wait + poll loop.
- Same UX. No fan-out, no pre-draft yet (those are layered later).
- Clean break: drop `wait_for_action`. Mandate CC v2.1.80+.

## Critical revision after spike research

The grill picked "Verify HTTP support first" expecting a yes. Research confirms: **CC Channels require a stdio MCP subprocess.** The current `uvicorn` HTTP server (MCP+hooks+SSE+GUI on `:7878`) cannot directly declare `claude/channel` because CC only subscribes to stdio-spawned MCP servers.

**Forced architecture: stdio shim**

```
┌──────────────────────────┐         ┌──────────────────────────────────┐
│  Claude Code (the CLI)   │ stdio   │  grill-cheese-shim (NEW)         │
│   - subscribes to        │◄───────►│   - registers MCP via stdio      │
│     channel notifications│         │   - proxies all MCP tool calls   │
│   - calls MCP tools      │         │     over HTTP to existing server │
└──────────────────────────┘         │   - subscribes to SSE on :7878   │
                                     │   - on flush event: emits        │
                                     │     mcp.notification(...)        │
                                     │     to CC via stdio              │
                                     └────────────┬─────────────────────┘
                                                  │ HTTP + SSE
                                     ┌────────────▼─────────────────────┐
                                     │  uvicorn server (existing)       │
                                     │   /mcp/ FastMCP                  │
                                     │   /hooks PreToolUse/PostToolUse  │
                                     │   /events SSE                    │
                                     │   /actions GUI clicks            │
                                     │   /  GUI static                  │
                                     └──────────────────────────────────┘
```

The HTTP server stays intact. Only added: a small stdio bridge process. Risk: extra moving part, two-process state coordination via SSE (already battle-tested for the GUI).

## Decisions carried from grill (ranked)

| # | Decision | Status after spike |
|---|----------|---------------------|
| 1 | Bottleneck = Claude per-turn latency | Unchanged |
| 2 | Mechanism = Channels-based push | Unchanged |
| 3 | Channels first (rollout order) | Unchanged |
| 4 | Clean break — remove `wait_for_action` | Unchanged |
| 5 | Pure transport swap (no fan-out) | Unchanged |
| 6 | Snapshot-on-wake on seq gap | Unchanged |
| 7 | Seq-hybrid payload (rich event + seq) | Unchanged |
| 8 | Batched per debounce window | Unchanged |
| 9 | Verify HTTP first | **CLOSED — HTTP unsupported. Stdio shim required.** |
| 10 | Server-response + skill prompt enforcement; `yield_turn()` deferred | Unchanged |
| 11 | Per-wake context cost = accept + monitor | Unchanged |

## Implementation order

### Phase 0 — pre-flight (1h)

1. Confirm CC v2.1.80+ on dev machine: `claude --version`. Upgrade if needed.
2. Read `code.claude.com/docs/en/channels` + `channels-reference` end-to-end. Confirm `--dangerously-load-development-channels server:grill-cheese-shim` works as expected.
3. Walking-skeleton spike: a minimal stdio MCP server that exposes one no-op tool + emits one `notifications/claude/channel` on a 5s timer. Confirm `<channel source="grill-cheese-shim" ...>` block actually injects into Claude's context. **Stop and re-plan if spike fails.**

### Phase 1 — stdio shim scaffold (2-3h)

New file: `server/shim.py`

Responsibilities:
- Run as stdio MCP server (`FastMCP("grill-cheese", ...)` over stdio transport)
- Declare `experimental: { 'claude/channel': {} }` capability
- Register the same MCP tools as today (`present_branches`, `present_summary`, `start_session`, `end_session`, `apply_chat_result`, `record_implicit_decision`, `get_session_snapshot`, `resume_session_tool`)
- Each tool implementation = HTTP POST to existing uvicorn server (e.g., `httpx.post(f"http://127.0.0.1:7878/internal/proxy/{tool_name}", json=args)`) and forward result
- On startup: open SSE subscription to `http://127.0.0.1:7878/events`
- On SSE `node_committed` event: emit channel notification (see Phase 2 for payload)
- On stdio close: cleanup SSE
- Healthcheck on startup: if HTTP server not reachable, error clearly with instructions

New endpoint on uvicorn server: `/internal/proxy/<tool_name>` accepting POST with tool args, calling the corresponding internal handler, returning result JSON. Bind to 127.0.0.1 only. (Alternative: shim could call `/mcp/` directly as an MCP HTTP client — slightly cleaner, no new endpoint. Pick this.)

CC config update (in user's `~/.claude.json`):
```jsonc
{
  "mcpServers": {
    "grill-cheese": {
      "command": "uv",
      "args": ["run", "python", "-m", "server.shim"],
      "cwd": "/Users/hoyin/Documents/grill-cheese"
    }
  }
}
```

CC launch flag (per session, until plugin-published): `claude --dangerously-load-development-channels server:grill-cheese`.

### Phase 2 — Channels payload contract (1h)

When `_flush()` fires server-side (via SSE event `node_committed`), shim emits:

```python
await mcp.send_notification({
    "method": "notifications/claude/channel",
    "params": {
        "content": json.dumps({
            "session_id": session_id,
            "node_id": node_id,
            "actions": committed_actions,  # List[AskBranchesResult]
            "seq": seq,                     # see seq numbering below
        }),
        "meta": {
            "session_id": session_id,
            "node_id": node_id,
            "seq": str(seq),
        },
    },
})
```

Resulting `<channel>` block in Claude's context:
```
<channel source="grill-cheese" session_id="ab12cd34" node_id="n3" seq="7">
{"session_id": "ab12cd34", "node_id": "n3", "actions": [...], "seq": 7}
</channel>
```

**Seq numbering** — per-session monotonic counter:
- Add `Session.next_seq: int = 0` to `schemas.py:Session`
- In `state.py:_flush`, before broadcast: `seq = session.next_seq; session.next_seq += 1`
- Persist with session JSON (already in `_persist`)
- Emit with every channel notification + `node_committed` SSE
- Skill tracks `last_seen_seq` in its own context (i.e., from prior wake)

### Phase 3 — server-side changes (2-3h)

`server/state.py`:
- Add `next_seq` field on `Session`
- `_flush()` emits new `node_committed` SSE payload including `seq`
- Keep `asyncio.Event` per node — still useful for any in-process consumer; harmless

`server/schemas.py`:
- Drop `WaitForActionResult` (no longer used)
- Add `seq: int` to `node_committed` SSE event payload (typed as a TypedDict if you have one; otherwise just dict)

`server/mcp_app.py`:
- **DELETE** the `wait_for_action` tool entirely (lines 209-266)
- `present_branches` return value: keep `{node_id}` but also include an `instruction` field per decision #10:
  ```python
  return {
      "node_id": node.id,
      "instruction": "TURN_OVER. Stop generating. Channel will wake you when the user clicks.",
  }
  ```
- Same `instruction` field on `present_summary` return.

`server/server.py`:
- No changes for now (HTTP server unchanged; shim runs separately)
- Optional: add `/internal/healthcheck` endpoint for shim startup probe

### Phase 4 — skill rewrite (1-2h)

`skill/grill-cheese/SKILL.md`:

Replace "The grill loop" steps 3-4 (the `present_branches → wait_for_action → re-poll` pattern) with:

```
3. Push the node. Call `present_branches(...)`. Returns `{node_id, instruction}`.
   The `instruction` says "TURN_OVER" — that's literal. After this call,
   stop generating. End your turn. Do NOT call any other tool. Do NOT
   write more text. The channel will wake you.

4. Wake handling. When you next see input, look for a <channel source="grill-cheese" ...>
   block in the latest user message. Parse its JSON content:
     {session_id, node_id, actions, seq}
   - If `seq == last_seen_seq + 1` (or first wake): act on inline `actions`
     directly. No snapshot call needed.
   - If `seq` jumped: call `get_session_snapshot(session_id)`, replay any
     missed flushed nodes from the snapshot, then act.
   - If no <channel> block but conversation resumed (e.g., user typed a chat
     message): you're in chat mode for the locked node — see Chat as decision.

   Track `last_seen_seq` mentally per session.
```

Update Hard rules:
- Remove "On empty `actions`, re-poll the same `node_id`" (no more polling)
- Add: "After `present_branches` or `present_summary`, your turn ENDS. The tool result text says TURN_OVER. Honor it. Wait for channel wake."
- Add: "On wake, parse `<channel>` JSON content. Use seq to decide fast-path vs snapshot fallback."

Update "Chat as decision":
- After `apply_chat_result(...)` returns ok, you can immediately push next `present_branches` in the same turn. Then end turn. (apply_chat_result is NOT triggered by a channel — it's user-typed-in-chat, normal CC flow.)

Update "Ending":
- `stop` action arrives via channel → push `present_summary(...)` → end turn → wake on summary verdict via channel → handle per-action.

Update the example tool calls section to reflect channel wake flow (drop the `wait_for_action` calls, show `<channel>` block parsing).

### Phase 5 — telemetry (1h)

Per decision #10 + #11. Picked branch was unresolved at session end ("telemetry shape" got `stop` before pick). **Defaulting to per-session JSONL log** (the recommended branch) — easiest, fits existing on-disk pattern.

New: `~/.grill-cheese/project-{slug}/sessions/{id}.events.jsonl`

Append on:
- `present_branches` call: `{ts, type: "push", node_id, instruction_sent: true}`
- Channel notification emit (in shim): `{ts, type: "notify", node_id, seq}`
- Next MCP tool call from same session: `{ts, type: "next_call", tool, gap_ms_since_push}`
  - **Boundary violation flag**: `gap_ms_since_push < 100` AND tool is not `apply_chat_result` or terminal-flow-related → `violation: true`
- Channel wake interval (ts diff between consecutive notifications) — for cache TTL diagnostics

Aggregate analysis script (later, only if needed):
```bash
jq 'select(.violation == true)' ~/.grill-cheese/**/*.events.jsonl | wc -l
```

If violations >5% over a session sample → ship `yield_turn()` enforcement (see deferred work).

### Phase 6 — manual verification (1h)

1. Launch uvicorn server.
2. Launch `claude --dangerously-load-development-channels server:grill-cheese` in repo dir.
3. Drive the `/grill-cheese` slash command end-to-end with a small brief.
4. Verify on canvas:
   - Card appears
   - Click a branch
   - Claude wakes within ~1s
   - Push next card
5. Inspect telemetry JSONL — confirm no boundary violations, seq numbers contiguous, wake intervals as expected.
6. Test resilience: kill+restart shim mid-session. Confirm next click fires snapshot-on-wake catch-up correctly.
7. Test chat flow: click chat, chat in CC, signal back, confirm `apply_chat_result` lands and next push works.

### Phase 7 — code review (mandatory per CLAUDE.md)

Spawn `feature-dev:code-reviewer` with the diff. Address any critical issues. Re-review after fixes.

## Files touched

| File | Change |
|------|--------|
| `server/shim.py` | NEW — stdio MCP shim, SSE subscriber, channel emitter |
| `server/state.py` | Add `next_seq` on Session; `_flush` emits seq; persist |
| `server/schemas.py` | Drop `WaitForActionResult`; add seq to `node_committed` payload |
| `server/mcp_app.py` | Delete `wait_for_action` tool; add `instruction` field to `present_branches`/`present_summary` returns |
| `server/server.py` | Optional `/internal/healthcheck` |
| `skill/grill-cheese/SKILL.md` | Rewrite loop, hard rules, ending; update examples |
| `gui/src/types.ts` | Add `seq` to `NodeCommittedEvent`; remove `WaitForActionResult` if mirrored |
| `pyproject.toml` | Add `httpx` if not already present (for shim → HTTP server) |
| `claude-mcp-config.example.json` | Update to show stdio shim registration + Channels flag |
| `PLAN-channels-migration.md` | This doc |

## Out of scope (later PRs)

- **Multi-node fan-out** (parallel questions per turn) — biggest UX win after Channels lands
- **In-context pre-draft** (skill writes branch-conditioned follow-ups in same turn as push)
- **`yield_turn()` enforcement** — only ship if telemetry shows >5% boundary violations
- **Per-session compaction** — only ship if cache miss rate proves painful from telemetry
- **Plugin packaging** — to skip `--dangerously-load-development-channels`. Get added to Anthropic allowlist eventually.
- **Permission relay** (`claude/channel/permission` capability) — unrelated, deferred

## Estimated agent-time

| Phase | Estimate |
|-------|----------|
| 0 — pre-flight + walking-skeleton spike | 1h |
| 1 — stdio shim scaffold | 2-3h |
| 2 — payload contract | 1h |
| 3 — server-side changes | 2-3h |
| 4 — skill rewrite | 1-2h |
| 5 — telemetry | 1h |
| 6 — manual verification | 1h |
| 7 — code review + fixes | 1-2h |
| **Total** | **~10-14h agent-time** |

Block on Phase 0 spike. If Channels-over-stdio behaves differently than docs suggest (e.g., notification cadence quirks, queueing surprises), pause and re-plan before Phase 1.

## Risks

1. **Shim ↔ HTTP server race conditions**. Two processes. SSE delivery is at-least-once but ordering across reconnects could glitch. Mitigation: seq numbers + snapshot-on-wake.
2. **Channels research-preview API churn**. Anthropic could change the protocol. Mitigation: pin CC version; isolate channel-specific code in shim.
3. **Skill obedience to TURN_OVER**. The whole win evaporates if Claude keeps spinning. Mitigation: dual-channel enforcement (skill prompt + tool result instruction) + telemetry.
4. **Subscribe to SSE from shim could miss events during shim restart**. Mitigation: on shim startup, snapshot all sessions, find any nodes with `is_flushed=true` since last seq, emit catch-up channel events.
5. **Two CC users on same machine**: only one shim instance per CC session. Probably fine since each CC session spawns its own subprocess.

## Open questions to resolve before Phase 1

1. Does the shim need to handle the `_grill_session_id` / `_grill_node_id` injection that the current skill does (per CLAUDE.md "Hook → node linking")? If yes, shim must rewrite tool args from CC before forwarding to HTTP server.
2. SSE delivery during shim startup: how many missed events to replay? Probably "all flushed nodes since last persisted last_seen_seq" — but we don't persist `last_seen_seq` per channel-subscriber today. Add to session schema.
3. Does CC's stdio MCP support the same MCP tool surface as HTTP MCP? Specifically: does FastMCP `streamable_http_app()` have a stdio-equivalent that supports the same `@mcp.tool()` decorators identically? (Almost certainly yes via `mcp.run_stdio_async()`.)
