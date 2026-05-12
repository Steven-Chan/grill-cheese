import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchSetupStatus, type SetupStatus } from "../api";

// /setup — first-run surface. fs-probed 3-step checklist + non-probed
// invocation section. Re-probes on mount and on tab focus
// (visibilitychange). No polling, no fs watcher. See CONTEXT.md
// "First-run surfaces".

type StepKey = "skill" | "hooks" | "mcp";

interface StepDef {
  key: StepKey;
  title: string;
  command: string;
  hint: string;
}

const STEPS: StepDef[] = [
  {
    key: "skill",
    title: "Install the skill",
    command: "cp -r skill/grill-cheese ~/.claude/skills/",
    hint: "Copies SKILL.md into your CC skills directory so /grill-cheese is recognized.",
  },
  {
    key: "hooks",
    title: "Install hooks",
    command: "./scripts/install-hooks.sh",
    hint: "Drops hook.js into ~/.claude/grill-cheese/ and registers it under hooks in ~/.claude/settings.json.",
  },
  {
    key: "mcp",
    title: "Register MCP server",
    command: "cp claude-mcp-config.example.json ~/.claude.json  # or merge mcpServers.grill-cheese into your existing ~/.claude.json",
    hint: "Adds the stdio shim entry so CC spawns server.shim on session start.",
  },
];

export function SetupPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reprobe = useCallback(() => {
    fetchSetupStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    reprobe();
    const onVis = () => {
      if (document.visibilityState === "visible") reprobe();
    };
    const onFocus = () => reprobe();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
    };
  }, [reprobe]);

  const allGreen = status !== null && status.skill && status.hooks && status.mcp;

  return (
    <div className="gc-page gc-setup-page">
      <header className="gc-setup-header">
        <Link to="/sessions" className="gc-back-link">← sessions</Link>
        <h1>Setup</h1>
        <p className="gc-dim">
          grill-cheese needs three things on disk for Claude Code to drive the canvas.
        </p>
      </header>

      {error && <div className="gc-empty">failed to probe: {error}</div>}

      <section className="gc-setup-checklist">
        {STEPS.map((s) => (
          <ChecklistRow
            key={s.key}
            step={s}
            ok={status?.[s.key] ?? null}
          />
        ))}
        <div className="gc-setup-reprobe-row">
          <button
            type="button"
            className="gc-setup-reprobe"
            onClick={reprobe}
          >
            re-check
          </button>
          <span className="gc-dim gc-setup-reprobe-hint">
            auto-rechecks when the tab regains focus
          </span>
        </div>
      </section>

      <section className="gc-setup-invocation">
        <h2>How to launch</h2>
        <p className="gc-dim gc-setup-loop-explainer">
          Claude will push questions to this page — click an option or type your own answer.
        </p>
        <CodeBlock
          label="In your project repo:"
          code="claude --dangerously-load-development-channels server:grill-cheese"
        />
        <CodeBlock
          label="Then, inside Claude Code:"
          code="/grill-cheese <your plan>"
        />
      </section>

      {allGreen && (
        <div className="gc-setup-complete gc-dim" role="status">
          ✓ all set — head back to <Link to="/sessions">sessions</Link>.
        </div>
      )}
    </div>
  );
}

function ChecklistRow({ step, ok }: { step: StepDef; ok: boolean | null }) {
  const state = ok === null ? "pending" : ok ? "ok" : "missing";
  const [expanded, setExpanded] = useState(state === "missing");
  // when status flips, sync expansion: collapse on green, expand on red
  useEffect(() => {
    if (state === "ok") setExpanded(false);
    else if (state === "missing") setExpanded(true);
  }, [state]);

  const dot = state === "ok" ? "✓" : state === "missing" ? "✗" : "…";

  return (
    <div className={`gc-setup-step gc-setup-step-${state}`}>
      <button
        type="button"
        className="gc-setup-step-head"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className={`gc-setup-dot gc-setup-dot-${state}`}>{dot}</span>
        <span className="gc-setup-step-title">{step.title}</span>
      </button>
      {expanded && (
        <div className="gc-setup-step-body">
          <p className="gc-dim gc-setup-step-hint">{step.hint}</p>
          <CodeBlock code={step.command} />
        </div>
      )}
    </div>
  );
}

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // best-effort
    }
  };
  return (
    <div className="gc-setup-codeblock">
      {label && <div className="gc-setup-codeblock-label gc-dim">{label}</div>}
      <div className="gc-setup-codeblock-row">
        <code>{code}</code>
        <button type="button" className="gc-setup-copy" onClick={onCopy} aria-label="copy">
          {copied ? "copied" : "copy"}
        </button>
      </div>
    </div>
  );
}
