"""Filesystem probes for the /setup checklist (CONTEXT.md: Setup checklist).

Three boolean probes — skill / hooks / mcp. Each reads files under
``~/.claude/``; never executes anything. Errors degrade to False so the
checklist surfaces "not installed" instead of crashing the page.
"""
from __future__ import annotations

import json
from pathlib import Path


def _home_claude() -> Path:
    return Path.home() / ".claude"


def probe_skill() -> bool:
    """Skill dir present with SKILL.md."""
    skill_md = _home_claude() / "skills" / "grill-cheese" / "SKILL.md"
    return skill_md.is_file()


def probe_hooks() -> bool:
    """hook.js dropped AND settings.json has a hooks entry referencing it."""
    home_cc = _home_claude()
    hook_js = home_cc / "grill-cheese" / "hook.js"
    if not hook_js.is_file():
        return False
    settings = home_cc / "settings.json"
    if not settings.is_file():
        return False
    try:
        data = json.loads(settings.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    hooks = data.get("hooks") if isinstance(data, dict) else None
    if not isinstance(hooks, dict):
        return False
    # any entry across any event whose command references our hook.js
    needle = "grill-cheese/hook.js"
    for arr in hooks.values():
        if not isinstance(arr, list):
            continue
        for h in arr:
            cmds = h.get("hooks") if isinstance(h, dict) else None
            if not isinstance(cmds, list):
                continue
            for c in cmds:
                cmd = c.get("command") if isinstance(c, dict) else None
                if isinstance(cmd, str) and needle in cmd:
                    return True
    return False


def probe_mcp() -> bool:
    """~/.claude.json has mcpServers.grill-cheese."""
    cfg = Path.home() / ".claude.json"
    if not cfg.is_file():
        return False
    try:
        data = json.loads(cfg.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(data, dict):
        return False
    servers = data.get("mcpServers")
    return isinstance(servers, dict) and "grill-cheese" in servers


def setup_status() -> dict:
    return {
        "skill": probe_skill(),
        "hooks": probe_hooks(),
        "mcp": probe_mcp(),
    }
