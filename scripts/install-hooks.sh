#!/usr/bin/env bash
# Install grill-cheese hook script + register hooks in ~/.claude/settings.json
# Pattern stolen from patoles/agent-flow.
set -euo pipefail

HOME_CC="${HOME}/.claude"
HOOK_DIR="${HOME_CC}/grill-cheese"
HOOK_JS="${HOOK_DIR}/hook.js"
SETTINGS="${HOME_CC}/settings.json"
SERVER_URL="${GRILL_CHEESE_HOOK_URL:-http://127.0.0.1:7878/hooks}"

mkdir -p "${HOOK_DIR}"

cat > "${HOOK_JS}" <<'EOF'
#!/usr/bin/env node
// grill-cheese hook forwarder. Reads CC hook payload from stdin, POSTs to local server.
// Two-stage budget: stdin must finish in 1s; HTTP must finish in 1s after stdin-end.
const http = require("http");
const url = require("url");
const TARGET = process.env.GRILL_CHEESE_HOOK_URL || "http://127.0.0.1:7878/hooks";
const STDIN_DEADLINE_MS = 1000;
const HTTP_TIMEOUT_MS = 1000;

const stdinTimer = setTimeout(() => process.exit(0), STDIN_DEADLINE_MS);
stdinTimer.unref();

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  clearTimeout(stdinTimer);
  // hard-kill timer for the HTTP phase only — independent of stdin time
  const httpTimer = setTimeout(() => process.exit(0), HTTP_TIMEOUT_MS + 500);
  httpTimer.unref();
  let payload;
  try { payload = JSON.parse(buf || "{}"); } catch { process.exit(0); }
  const u = url.parse(TARGET);
  const data = JSON.stringify(payload);
  const req = http.request(
    {
      method: "POST",
      hostname: u.hostname,
      port: u.port,
      path: u.path,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      timeout: HTTP_TIMEOUT_MS,
    },
    (res) => { res.resume(); res.on("end", () => process.exit(0)); }
  );
  req.on("timeout", () => { req.destroy(); process.exit(0); });
  req.on("error", () => process.exit(0));
  req.write(data);
  req.end();
});
process.stdin.on("error", () => process.exit(0));
EOF

chmod +x "${HOOK_JS}"

if [ ! -f "${SETTINGS}" ]; then
  echo "{}" > "${SETTINGS}"
fi

# Use python for a safe JSON merge — avoids depending on jq.
python3 - "$SETTINGS" "$HOOK_JS" "$SERVER_URL" <<'PY'
import json, sys, os
settings_path, hook_js, _url = sys.argv[1], sys.argv[2], sys.argv[3]
with open(settings_path) as f:
    settings = json.load(f) or {}
hooks = settings.setdefault("hooks", {})
events = ["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd", "Stop"]
cmd = f'node "{hook_js}"'
for ev in events:
    arr = hooks.setdefault(ev, [])
    # de-dup our entry
    arr = [h for h in arr if not (isinstance(h, dict) and h.get("hooks") and any(c.get("command") == cmd for c in h["hooks"]))]
    arr.append({"matcher": "*", "hooks": [{"type": "command", "command": cmd, "timeout": 3}]})
    hooks[ev] = arr
with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)
print(f"installed grill-cheese hooks into {settings_path}")
PY

echo "done."
echo ""
echo "next steps:"
echo "  1. ensure server is running: uv run python -m server.server"
echo "  2. copy MCP config: cp claude-mcp-config.example.json ~/.claude.json (or merge mcpServers)"
echo "  3. copy skill: cp -r skill/grill-cheese ~/.claude/skills/"
