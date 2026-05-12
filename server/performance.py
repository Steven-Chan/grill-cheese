"""Performance log: append + read for ~/.grill-cheese/performance.jsonl.

One line per ended session. Survives session JSON pruning by design — see
ADR-0003. Append-only; no compaction, no in-memory cache. /api/performance
re-reads on every request; /api/sessions joins by session_id likewise.
"""
from __future__ import annotations

import logging
import pathlib

from .schemas import PerformanceEntry

logger = logging.getLogger(__name__)


def _log_path() -> pathlib.Path:
    return pathlib.Path.home() / ".grill-cheese" / "performance.jsonl"


def append(entry: PerformanceEntry) -> None:
    p = _log_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(entry.model_dump_json() + "\n")
    except Exception:
        logger.exception("perf append failed for session %s", entry.session_id)


def read_all() -> list[PerformanceEntry]:
    """Return every entry newest-first. Tolerates corrupt lines (skip + warn).
    Empty list when the log doesn't exist yet."""
    p = _log_path()
    if not p.exists():
        return []
    out: list[PerformanceEntry] = []
    try:
        for line in p.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                out.append(PerformanceEntry.model_validate_json(line))
            except Exception:
                logger.warning("skipping corrupt perf line")
    except Exception:
        logger.exception("perf read failed")
    out.sort(key=lambda e: e.ended_at, reverse=True)
    return out


def index_by_session() -> dict[str, PerformanceEntry]:
    """{session_id: entry} for /api/sessions join. Last-write-wins on the rare
    duplicate id (shouldn't happen — session ids are uuids)."""
    return {e.session_id: e for e in read_all()}
