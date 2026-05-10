import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { DecisionNode as DNode, Branch } from "../types";
import { postAction } from "../api";
import { useStore } from "../store";

interface Data {
  node: DNode;
  isPending: boolean;
}

const stateGlyph: Record<Branch["state"], string> = {
  considered: "·",
  rejected: "✕",
  chosen: "●",
};

export function DecisionNode({ data }: NodeProps) {
  const { node, isPending } = data as unknown as Data;
  const sid = useStore((s) => s.activeSessionId);
  const traces = useStore((s) => s.hookTraces[node.id] || []);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");

  const send = async (
    action: "next" | "other" | "mark_rejected" | "unmark" | "chat",
    bid?: string,
    note?: string
  ) => {
    if (!sid) return;
    try {
      await postAction(sid, node.id, action, bid, note);
    } catch (e) {
      console.error(e);
    }
  };

  const submitOther = async () => {
    const t = otherText.trim();
    if (!t) return;
    await send("other", undefined, t);
    setOtherText("");
    setOtherOpen(false);
  };

  const committed = !!node.committed;
  return (
    <div className={`gc-node ${node.implicit ? "implicit" : ""} ${isPending ? "pending" : ""} ${committed ? "committed" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="gc-node-head">
        <span className="gc-node-depth">d{node.depth}</span>
        {node.implicit && <span className="gc-node-tag">implicit</span>}
        {isPending && !committed && <span className="gc-node-tag pulse">awaiting</span>}
        {committed && <span className="gc-node-tag">settled</span>}
      </div>
      <div className="gc-node-q">{node.question}</div>
      {node.reasoning && (
        <div className="gc-node-reasoning-body">{node.reasoning}</div>
      )}
      <div className="gc-branches">
        {node.branches.map((b) => (
          <BranchRow key={b.id} branch={b} onPick={send} pending={isPending && !committed} committed={committed} />
        ))}
        {isPending && !committed && (
          <div className="gc-branch other">
            {!otherOpen ? (
              <div className="gc-branch-row">
                <span className="gc-branch-glyph">+</span>
                <button className="gc-btn ghost" onClick={() => setOtherOpen(true)}>
                  Other / type your answer
                </button>
              </div>
            ) : (
              <div className="gc-other-box">
                <textarea
                  className="gc-other-input"
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  placeholder="Your answer — Claude will use this to drive the next question."
                  rows={3}
                  autoFocus
                />
                <div className="gc-branch-actions">
                  <button className="gc-btn primary" onClick={submitOther}>
                    send
                  </button>
                  <button
                    className="gc-btn ghost"
                    onClick={() => {
                      setOtherOpen(false);
                      setOtherText("");
                    }}
                  >
                    cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {isPending && !committed && (
          <div className="gc-branch chat">
            <div className="gc-branch-row">
              <span className="gc-branch-glyph">⎘</span>
              <button
                className="gc-btn ghost"
                onClick={() => send("chat")}
                title="Pause grill, chat about this question in Claude Code"
              >
                Chat about this
              </button>
            </div>
          </div>
        )}
      </div>
      {node.user_note && (
        <div className="gc-user-note">
          <span className="gc-node-tag">other</span>
          <div className="gc-user-note-body">{node.user_note}</div>
        </div>
      )}
      {traces.length > 0 && (
        <div className="gc-hooks">
          <button className="gc-link" onClick={() => setHooksOpen((o) => !o)}>
            {hooksOpen ? "hide" : `${traces.length} tool call${traces.length > 1 ? "s" : ""}`}
          </button>
          {hooksOpen && (
            <ul className="gc-hooks-list">
              {traces.map((t, i) => (
                <li key={i}>
                  <code>{t.tool_name || t.hook_event_name}</code>
                  <span className="gc-hooks-input">{summarizeInput(t.tool_input)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function BranchRow({
  branch,
  onPick,
  pending,
  committed,
}: {
  branch: Branch;
  onPick: (a: "next" | "other" | "mark_rejected" | "unmark" | "chat", bid?: string, note?: string) => void;
  pending: boolean;
  committed: boolean;
}) {
  const [showRationale, setShowRationale] = useState(false);
  return (
    <div className={`gc-branch state-${branch.state} ${branch.is_recommended ? "recommended" : ""}`}>
      <Handle
        type="source"
        position={Position.Right}
        id={branch.id}
        style={{ top: "50%", right: -6 }}
      />
      <div className="gc-branch-row">
        <span className="gc-branch-glyph" title={branch.state}>
          {stateGlyph[branch.state]}
        </span>
        <span className="gc-branch-label">
          {branch.label}
          {branch.is_recommended && <span className="gc-rec">★</span>}
        </span>
        {branch.rationale && (
          <button
            type="button"
            className={`gc-branch-chevron nodrag ${showRationale ? "open" : ""}`}
            onClick={() => setShowRationale((o) => !o)}
            aria-expanded={showRationale}
            aria-label={showRationale ? "hide rationale" : "show rationale"}
            title={showRationale ? "hide rationale" : "show rationale"}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M2.5 4.5L6 8l3.5-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      {showRationale && branch.rationale && (
        <div className="gc-branch-rationale">{branch.rationale}</div>
      )}
      {!committed && (
        <div className="gc-branch-actions">
          {branch.state === "chosen" ? (
            <button className="gc-btn ghost" onClick={() => onPick("unmark", branch.id)}>
              unmark
            </button>
          ) : pending ? (
            <>
              <button className="gc-btn primary" onClick={() => onPick("next", branch.id)}>
                pick →
              </button>
              <button
                className="gc-btn ghost"
                onClick={() => onPick("mark_rejected", branch.id)}
              >
                reject
              </button>
              <button
                className="gc-btn ghost"
                onClick={() => onPick("chat", branch.id)}
                title="Pause grill, chat about THIS option in CC"
              >
                chat
              </button>
            </>
          ) : (
            <button
              className="gc-btn ghost"
              onClick={() => onPick("mark_rejected", branch.id)}
            >
              reject
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function summarizeInput(input: Record<string, unknown>): string {
  if (!input) return "";
  const keys = ["file_path", "pattern", "command", "path", "url"];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string") return v.slice(0, 80);
  }
  return "";
}
