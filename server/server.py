"""Entry: Starlette app mounting MCP + SSE + hooks + GUI static."""
from __future__ import annotations

import contextlib
import os
from pathlib import Path

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

from .hooks import (
    actions_endpoint,
    export_md_endpoint,
    hooks_endpoint,
    sessions_endpoint,
    snapshot_endpoint,
)
from .mcp_app import mcp
from .sse import events_endpoint


@contextlib.asynccontextmanager
async def lifespan(app: Starlette):
    async with mcp.session_manager.run():
        yield


# CC's MCP HTTP client posts to /mcp (no trailing slash). Starlette Mount only
# matches /mcp/<...>, so bare /mcp falls through to the GUI static handler and
# gets 405. Solve at ASGI layer by rewriting bare /mcp -> /mcp/ before the
# router sees it; then a single Mount("/mcp/") covers everything, and the inner
# Starlette app routes "/" (since streamable_http_path="/").
class _McpPathFixup:
    def __init__(self, inner: ASGIApp) -> None:
        self.inner = inner

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope.get("path") == "/mcp":
            scope = dict(scope)
            scope["path"] = "/mcp/"
            scope["raw_path"] = b"/mcp/"
        await self.inner(scope, receive, send)


class _McpRouter:
    """ASGI app that strips the Mount prefix and forwards to the inner MCP app
    with path rewritten to "/" (the inner Starlette route)."""

    def __init__(self, inner: ASGIApp) -> None:
        self.inner = inner

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            scope = dict(scope)
            scope["path"] = "/"
            scope["raw_path"] = b"/"
        await self.inner(scope, receive, send)


_mcp_inner = mcp.streamable_http_app()
_mcp_router = _McpRouter(_mcp_inner)


def _gui_routes() -> list:
    here = Path(__file__).resolve().parent.parent
    dist = here / "gui" / "dist"
    if dist.exists():
        return [Mount("/", app=StaticFiles(directory=str(dist), html=True), name="gui")]
    return []


routes = [
    Route("/events", events_endpoint, methods=["GET"]),
    Route("/hooks", hooks_endpoint, methods=["POST"]),
    Route("/actions", actions_endpoint, methods=["POST"]),
    Route("/sessions", sessions_endpoint, methods=["GET"]),
    Route("/snapshot/{sid}", snapshot_endpoint, methods=["GET"]),
    Route("/export/{sid}.md", export_md_endpoint, methods=["GET"]),
    Mount("/mcp/", app=_mcp_router),
    *_gui_routes(),
]


_inner_app = Starlette(
    routes=routes,
    lifespan=lifespan,
    middleware=[
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["*"],
            allow_headers=["*"],
        )
    ],
)
# /mcp -> /mcp/ rewrite has to run BEFORE the Starlette router decides routing
app: ASGIApp = _McpPathFixup(_inner_app)


def main() -> None:
    import uvicorn

    host = os.environ.get("GRILL_CHEESE_HOST", "127.0.0.1")
    port = int(os.environ.get("GRILL_CHEESE_PORT", "7878"))
    uvicorn.run(
        "server.server:app",
        host=host,
        port=port,
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
