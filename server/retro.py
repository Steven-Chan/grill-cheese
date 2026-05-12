"""Retro module — disagreement collection + doc state + marker bookkeeping.

Reads ended session JSONs (excluding `kind="retro"`) since the last retro
marker for a project, plus current doc state (CLAUDE.md / ADRs / CONTEXT.md /
skill files / global CLAUDE.md). Composes the brief for a `kind="retro"`
grill session. See ADR-0005.
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
import pathlib
from typing import Any, Optional

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

DATA_ROOT = pathlib.Path.home() / ".grill-cheese"
CMUX_DEFAULT_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux"

# project doc paths read into the retro brief — agent decides which to edit
PROJECT_DOC_NAMES = ("CLAUDE.md", "CONTEXT.md", "CONTEXT-MAP.md")
ADR_GLOB = "docs/adr/*.md"
SKILL_GLOB = "skill/*/SKILL.md"

GLOBAL_USER_CLAUDE_MD = pathlib.Path.home() / ".claude" / "CLAUDE.md"
GLOBAL_SKILLS_ROOT = pathlib.Path.home() / ".claude" / "skills"


# ---- marker ----

def _marker_path(project: str) -> pathlib.Path:
    slug = project if project else "_default"
    return DATA_ROOT / f"project-{slug}" / ".last-retro"


def read_marker(project: str) -> Optional[_dt.datetime]:
    p = _marker_path(project)
    if not p.exists():
        return None
    try:
        return _dt.datetime.fromisoformat(p.read_text(encoding="utf-8").strip())
    except Exception:
        logger.exception("read_marker: bad marker at %s", p)
        return None


def write_marker(project: str, ts: Optional[_dt.datetime] = None) -> None:
    if ts is None:
        ts = _dt.datetime.now(_dt.timezone.utc)
    p = _marker_path(project)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(ts.isoformat(), encoding="utf-8")
    tmp.replace(p)


# ---- disagreement collection ----

class DisagreedNode(BaseModel):
    session_id: str
    session_title: Optional[str] = None
    session_ended_at: Optional[float] = None
    node_id: str
    question: str
    reasoning: str = ""
    branches: list[dict[str, Any]] = Field(default_factory=list)
    recommended_branch_labels: list[str] = Field(default_factory=list)
    chosen_branch_labels: list[str] = Field(default_factory=list)
    own_answer: Optional[str] = None
    chat_messages: list[dict[str, Any]] = Field(default_factory=list)
    redirected: bool = False
    removed_branch_labels: list[str] = Field(default_factory=list)
    recommendation_score: Optional[float] = None


class RetroBrief(BaseModel):
    project: str
    since: Optional[str] = None  # ISO timestamp or None for all-history
    is_empty: bool
    session_count: int = 0
    disagreed: list[DisagreedNode] = Field(default_factory=list)
    doc_state: dict[str, str] = Field(default_factory=dict)


def _sessions_dir(project: str) -> pathlib.Path:
    slug = project if project else "_default"
    return DATA_ROOT / f"project-{slug}" / "sessions"


def _iter_session_files(project: str) -> list[pathlib.Path]:
    d = _sessions_dir(project)
    if not d.exists():
        return []
    return sorted(d.glob("*.json"))


def _load_session(path: pathlib.Path) -> Optional[dict[str, Any]]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("retro: failed to load %s", path)
        return None


def _extract_disagreed(s: dict[str, Any]) -> list[DisagreedNode]:
    """Walk session nodes; collect those with recommendation_score < 1.

    Skips summary nodes, implicit decisions, and nodes with score=None
    (no signal). Captures the labels of recommended branches so retro
    can reason about agent picks without re-deriving from is_recommended.
    """
    out: list[DisagreedNode] = []
    nodes = s.get("nodes", {}) or {}
    for nid, n in nodes.items():
        score = n.get("recommendation_score")
        if score is None or score >= 1.0:
            continue
        if n.get("kind") == "summary" or n.get("implicit"):
            continue
        branches = n.get("branches", []) or []
        rec_labels = [b.get("label", "") for b in branches if b.get("is_recommended")]
        # chosen_branch_labels live on the last committed_actions entry
        committed = n.get("committed_actions", []) or []
        chosen_labels: list[str] = []
        own_answer = None
        if committed:
            last = committed[-1]
            chosen_labels = list(last.get("chosen_branch_labels", []) or [])
            own_answer = last.get("own_answer")
        removed_ids = set(n.get("removed_branch_ids", []) or [])
        removed_labels = [b.get("label", "") for b in branches if b.get("id") in removed_ids]
        out.append(DisagreedNode(
            session_id=s.get("id", ""),
            session_title=s.get("title"),
            session_ended_at=s.get("ended_at"),
            node_id=nid,
            question=n.get("question", ""),
            reasoning=n.get("reasoning", ""),
            branches=[
                {"id": b.get("id"), "label": b.get("label", ""),
                 "rationale": b.get("rationale", ""),
                 "is_recommended": bool(b.get("is_recommended")),
                 "user_authored": bool(b.get("user_authored"))}
                for b in branches
            ],
            recommended_branch_labels=rec_labels,
            chosen_branch_labels=chosen_labels,
            own_answer=own_answer,
            chat_messages=list(n.get("chat_messages", []) or []),
            redirected=bool(n.get("redirected")),
            removed_branch_labels=removed_labels,
            recommendation_score=score,
        ))
    return out


def collect_disagreement_data(
    project: str, since: Optional[_dt.datetime] = None
) -> tuple[list[DisagreedNode], int]:
    """Scan ended sessions for `project` since marker. Returns (disagreed, session_count).

    Filters out `kind="retro"` sessions (a retro doesn't retro itself — ADR-0005).
    """
    disagreed: list[DisagreedNode] = []
    session_count = 0
    since_ts = since.timestamp() if since else None
    for path in _iter_session_files(project):
        s = _load_session(path)
        if not s:
            continue
        if s.get("status") != "ended":
            continue
        if s.get("kind") == "retro":
            continue
        ended_at = s.get("ended_at") or s.get("started_at") or 0.0
        if since_ts is not None and ended_at <= since_ts:
            continue
        session_count += 1
        disagreed.extend(_extract_disagreed(s))
    return disagreed, session_count


# ---- doc state ----

def _safe_read(path: pathlib.Path) -> Optional[str]:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return None


def read_current_doc_state(repo_root: pathlib.Path) -> dict[str, str]:
    """Slurp doc state for retro to reason about.

    Keys are display paths (relative for repo files, ~ for global). Empty/missing
    files omitted. Heavy — caller decides what to truncate downstream.
    """
    out: dict[str, str] = {}
    repo_root = pathlib.Path(repo_root)
    # repo-local docs
    for name in PROJECT_DOC_NAMES:
        p = repo_root / name
        body = _safe_read(p)
        if body:
            out[name] = body
    for p in sorted(repo_root.glob(ADR_GLOB)):
        body = _safe_read(p)
        if body:
            out[str(p.relative_to(repo_root))] = body
    for p in sorted(repo_root.glob(SKILL_GLOB)):
        body = _safe_read(p)
        if body:
            out[str(p.relative_to(repo_root))] = body
    # global user CLAUDE.md
    body = _safe_read(GLOBAL_USER_CLAUDE_MD)
    if body:
        out["~/.claude/CLAUDE.md"] = body
    # installed skill files (read-only — for agent awareness)
    if GLOBAL_SKILLS_ROOT.exists():
        for p in sorted(GLOBAL_SKILLS_ROOT.glob("*/SKILL.md")):
            body = _safe_read(p)
            if body:
                out[f"~/.claude/skills/{p.parent.name}/SKILL.md"] = body
    return out


# ---- brief composition ----

def compose_brief(
    project: str, repo_root: pathlib.Path
) -> tuple[RetroBrief, str]:
    """Compose the retro session brief. Returns (RetroBrief, markdown_brief).

    The markdown_brief is what gets passed to start_session as the literal
    `brief` field — rendered in the GUI brief banner + read by the retro
    agent. The structured RetroBrief is what the MCP tool returns for the
    skill to introspect (e.g. is_empty short-circuit).
    """
    since = read_marker(project)
    disagreed, session_count = collect_disagreement_data(project, since)
    doc_state = read_current_doc_state(repo_root)
    brief = RetroBrief(
        project=project,
        since=since.isoformat() if since else None,
        is_empty=(session_count == 0 or len(disagreed) == 0),
        session_count=session_count,
        disagreed=disagreed,
        doc_state=doc_state,
    )
    md = _render_brief_markdown(brief)
    return brief, md


def _render_brief_markdown(b: RetroBrief) -> str:
    lines: list[str] = []
    lines.append(f"# Retrospective brief — project `{b.project}`")
    lines.append("")
    if b.since:
        lines.append(f"**Window:** sessions ended after `{b.since}`")
    else:
        lines.append("**Window:** all ended sessions (no prior retro marker)")
    lines.append(f"**Sessions scanned:** {b.session_count}")
    lines.append(f"**Disagreed decision nodes:** {len(b.disagreed)}")
    lines.append("")
    if b.is_empty:
        lines.append("_No disagreements in this window. Retro is a no-op._")
        return "\n".join(lines)
    lines.append("## Disagreed nodes")
    lines.append("")
    for d in b.disagreed:
        lines.append(f"### `{d.node_id}` — {d.question}")
        if d.reasoning:
            lines.append(f"> {d.reasoning}")
        lines.append("")
        if d.recommended_branch_labels:
            lines.append(f"- Agent recommended: {', '.join(d.recommended_branch_labels)}")
        if d.chosen_branch_labels:
            lines.append(f"- User picked: {', '.join(d.chosen_branch_labels)}")
        if d.own_answer:
            lines.append(f"- User typed (Own Answer): {d.own_answer!r}")
        if d.removed_branch_labels:
            lines.append(f"- Removed via chat: {', '.join(d.removed_branch_labels)}")
        if d.redirected:
            lines.append("- Redirected via chat")
        if d.chat_messages:
            lines.append("- Chat transcript:")
            for m in d.chat_messages:
                role = m.get("role", "?")
                text = (m.get("text") or "").strip().replace("\n", " ")
                lines.append(f"  - **{role}:** {text[:400]}")
        lines.append("")
    lines.append("## Current doc state (truncated bodies)")
    lines.append("")
    for path, body in b.doc_state.items():
        head = body.strip().splitlines()[:8]
        lines.append(f"- `{path}` ({len(body)} chars)")
        for line in head:
            lines.append(f"  > {line}")
    lines.append("")
    return "\n".join(lines)


# ---- cmux bin resolution ----

def resolve_cmux_bin(project: Optional[str] = None) -> Optional[str]:
    """Find a cmux binary path. Scans recent session JSONs for cmux.bin_path;
    falls back to the standard install location. Returns None if nothing
    looks executable.

    project: optional — restrict scan to that project's sessions first.
    """
    candidates: list[str] = []
    projects: list[str] = []
    if project:
        projects.append(project)
    # scan all projects as fallback
    for p in DATA_ROOT.glob("project-*"):
        slug = p.name[len("project-"):]
        if slug not in projects:
            projects.append(slug)
    for slug in projects:
        d = _sessions_dir(slug)
        if not d.exists():
            continue
        for path in sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:25]:
            s = _load_session(path)
            if not s:
                continue
            cmux = s.get("cmux") or {}
            bp = cmux.get("bin_path")
            if bp and bp not in candidates:
                candidates.append(bp)
                break  # one per project is enough
    candidates.append(CMUX_DEFAULT_BIN)
    for c in candidates:
        p = pathlib.Path(c)
        if p.exists() and p.is_file():
            return str(p)
    return None
