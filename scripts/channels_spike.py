"""Phase 0 spike — verify CC Channels works for a custom stdio MCP server.

Run via CC config:
    {
      "mcpServers": {
        "channels-spike": {
          "command": "uv",
          "args": ["run", "python", "-m", "scripts.channels_spike"],
          "cwd": "/Users/hoyin/Documents/grill-cheese"
        }
      }
    }

Launch CC:
    claude --dangerously-load-development-channels server:channels-spike

Then in CC: ask Claude to call the `spike_ping` tool. The tool returns "ok"
immediately AND schedules a channel notification 2s later. The notification
should inject as a `<channel source="channels-spike" tick="N">` block in the
next assistant turn.

If the block appears -> Channels works for custom stdio servers, plan can
proceed to Phase 1. If not -> re-evaluate.
"""
from __future__ import annotations

import asyncio
import sys
import time
from typing import Any

from mcp.server.lowlevel import Server, NotificationOptions
from mcp.server.stdio import stdio_server
import mcp.types as t


server = Server("channels-spike")
_counter = 0


def _log(msg: str) -> None:
    # stderr only — stdout is the MCP wire
    print(f"[spike] {msg}", file=sys.stderr, flush=True)


async def _delayed_notify(session, delay: float, tick: int) -> None:
    await asyncio.sleep(delay)
    try:
        notif_obj = t.Notification[dict, str](
            method="notifications/claude/channel",
            params={
                "content": f"spike tick {tick} at {time.time():.1f}",
                "meta": {"tick": str(tick), "source": "channels-spike"},
            },
        )
        wrapped = t.ServerNotification(notif_obj)  # type: ignore[arg-type]
        await session.send_notification(wrapped)
        _log(f"emitted notification tick={tick}")
    except Exception as e:
        _log(f"notify err: {e!r}")


@server.list_tools()
async def list_tools() -> list[t.Tool]:
    return [
        t.Tool(
            name="spike_ping",
            description="Probe. Returns 'ok' and emits one channel notification ~2s later.",
            inputSchema={"type": "object", "properties": {}, "required": []},
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[t.TextContent]:
    global _counter
    _counter += 1
    tick = _counter
    # Grab live session from request context
    sess = server.request_context.session
    asyncio.create_task(_delayed_notify(sess, 2.0, tick))
    return [
        t.TextContent(
            type="text",
            text=f"ok — scheduled channel notification tick={tick} in 2s",
        )
    ]


async def main() -> None:
    init_opts = server.create_initialization_options(
        notification_options=NotificationOptions(),
        experimental_capabilities={"claude/channel": {}},
    )
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, init_opts)


if __name__ == "__main__":
    asyncio.run(main())
