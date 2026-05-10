"""SSE endpoint helpers for /events."""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator, Optional

from starlette.requests import Request
from starlette.responses import Response
from sse_starlette.sse import EventSourceResponse

from .state import store


async def _stream(request: Request, sid: Optional[str]) -> AsyncIterator[dict]:
    q = await store.subscribe(sid)
    try:
        # initial hello so client knows it's alive
        yield {"event": "hello", "data": json.dumps({"sid": sid or "*"})}
        while True:
            if await request.is_disconnected():
                break
            try:
                ev = await asyncio.wait_for(q.get(), timeout=15.0)
            except asyncio.TimeoutError:
                # heartbeat
                yield {"event": "ping", "data": ""}
                continue
            yield {"event": ev.get("type", "message"), "data": json.dumps(ev)}
    finally:
        await store.unsubscribe(sid, q)


async def events_endpoint(request: Request) -> Response:
    sid = request.query_params.get("session")
    return EventSourceResponse(_stream(request, sid))
