"""Entry: Starlette app mounting MCP + SSE + hooks + GUI static."""
from __future__ import annotations

import contextlib
import os
from pathlib import Path

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import FileResponse, Response
from starlette.routing import Mount, Route
from starlette.types import ASGIApp, Receive, Scope, Send

from .hooks import (
    actions_endpoint,
    delete_session_endpoint,
    export_md_endpoint,
    hooks_endpoint,
    jump_to_cmux_endpoint,
    performance_endpoint,
    retro_endpoint,
    sessions_endpoint,
    snapshot_endpoint,
    wrap_endpoint,
)
from .internal_dispatch import (
    internal_notify_endpoint,
    internal_shortcut_endpoint,
    internal_tool_endpoint,
)
from .mcp_app import mcp
from .sse import events_endpoint
from .state import store


@contextlib.asynccontextmanager
async def lifespan(app: Starlette):
    await store._load_all()
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


def _spa_routes() -> list:
    """SPA fallback. Serves dist files when the request matches a real file
    under dist/; otherwise returns dist/index.html so BrowserRouter can
    handle the path client-side. Must be appended LAST so earlier explicit
    routes win (e.g. /api/*, /events, /mcp/, /export/*)."""
    here = Path(__file__).resolve().parent.parent
    dist = (here / "gui" / "dist").resolve()
    if not dist.exists():
        return []
    index = dist / "index.html"

    async def spa_handler(request):
        rel = request.path_params.get("path", "") or ""
        candidate = (dist / rel).resolve()
        # path-traversal guard
        try:
            candidate.relative_to(dist)
        except ValueError:
            return Response(status_code=404)
        if candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(index))

    return [Route("/{path:path}", spa_handler, methods=["GET"])]


routes = [
    Route("/events", events_endpoint, methods=["GET"]),
    Route("/hooks", hooks_endpoint, methods=["POST"]),
    # /api/* — data endpoints. Kept under a prefix so BrowserRouter can own
    # bare paths like /sessions and /sessions/<sid> in the SPA.
    Route("/api/actions", actions_endpoint, methods=["POST"]),
    Route("/api/sessions", sessions_endpoint, methods=["GET"]),
    Route("/api/sessions/{sid}", delete_session_endpoint, methods=["DELETE"]),
    Route("/api/sessions/{sid}/wrap", wrap_endpoint, methods=["POST"]),
    Route("/api/sessions/{sid}/jump-to-cmux", jump_to_cmux_endpoint, methods=["POST"]),
    Route("/api/snapshot/{sid}", snapshot_endpoint, methods=["GET"]),
    Route("/api/performance", performance_endpoint, methods=["GET"]),
    Route("/api/retro", retro_endpoint, methods=["POST"]),
    # /export/<sid>.md is a user-facing direct link (opened in a new tab),
    # so it stays at the top level rather than under /api/.
    Route("/export/{sid}.md", export_md_endpoint, methods=["GET"]),
    # /internal/tool/{name} — JSON dispatch used by the stdio shim. 127.0.0.1 only.
    Route("/internal/tool/{name}", internal_tool_endpoint, methods=["POST"]),
    Route("/internal/telemetry/notify", internal_notify_endpoint, methods=["POST"]),
    Route("/internal/telemetry/shortcut", internal_shortcut_endpoint, methods=["POST"]),
    Mount("/mcp/", app=_mcp_router),
    *_spa_routes(),
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
