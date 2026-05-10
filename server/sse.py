"""SSE endpoint helpers for /events."""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator, Optional

from starlette.requests import Request
from starlette.responses import Response
from sse_starlette.sse import EventSourceResponse

from .state import store


async def _stream(
    request: Request,
    sid: Optional[str],
    owner: Optional[str],
) -> AsyncIterator[dict]:
    q = await store.subscribe(sid=sid, owner=owner)
    try:
        # initial hello so client knows it's alive
        hello_tag = owner or sid or "*"
        yield {"event": "hello", "data": json.dumps({"sid": hello_tag})}
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
        await store.unsubscribe(sid, q, owner=owner)


async def events_endpoint(request: Request) -> Response:
    sid = request.query_params.get("session")
    owner = request.query_params.get("owner")
    return EventSourceResponse(_stream(request, sid, owner))
