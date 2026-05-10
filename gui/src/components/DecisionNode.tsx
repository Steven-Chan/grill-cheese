import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { DecisionNode as DNode, Branch, ChatBlock } from "../types";
import { postAction } from "../api";
import { useStore } from "../store";

interface Data {
  node: DNode;
  isPending: boolean;
}

export function DecisionNode({ data }: NodeProps) {
  const { node, isPending } = data as unknown as Data;
  const sid = useStore((s) => s.activeSessionId);
  const traces = useStore((s) => s.hookTraces[node.id] || []);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);

  const send = async (
    action: "next" | "other" | "chat",
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
  const redirected = !!node.redirected;
  const chats: ChatBlock[] = node.chats ?? [];
  const removedSet = new Set(node.removed_branch_ids ?? []);
  const chosenId = node.chosen_branch_id ?? null;
  const latestChat = chats.length > 0 ? chats[chats.length - 1] : null;
  const earlierChats = chats.length > 1 ? chats.slice(0, -1) : [];

  const wrapperClasses = [
    "gc-node",
    node.implicit ? "implicit" : "",
    isPending ? "pending" : "",
    committed ? "committed" : "",
    redirected ? "redirected" : "",
    chats.length > 0 ? "chatted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={wrapperClasses}>
      <Handle type="target" position={Position.Left} />
      <div className="gc-node-head">
        <span className="gc-node-depth">d{node.depth}</span>
        {node.implicit && <span className="gc-node-tag">implicit</span>}
        {redirected && <span className="gc-node-tag redirected">redirected</span>}
        {isPending && !committed && !redirected && (
          <span className="gc-node-tag pulse">awaiting</span>
        )}
        {committed && !redirected && <span className="gc-node-tag">settled</span>}
        {chats.length > 0 && (
          <span
            className="gc-node-tag chat-count"
            title={`${chats.length} chat${chats.length > 1 ? "s" : ""} applied`}
          >
            <ChatIcon /> {chats.length > 1 ? chats.length : null}
          </span>
        )}
      </div>
      <div className="gc-node-q">{node.question}</div>
      {node.reasoning && (
        <div className="gc-node-reasoning-body nowheel">{node.reasoning}</div>
      )}
      {latestChat && (
        <div className="gc-chat-banner">
          <div className="gc-chat-banner-head">
            <span className="gc-chat-banner-tag">chat · {latestChat.outcome}</span>
            {earlierChats.length > 0 && (
              <button
                className="gc-link"
                onClick={() => setChatHistoryOpen((o) => !o)}
              >
                {chatHistoryOpen
                  ? "hide history"
                  : `view ${earlierChats.length} earlier chat${earlierChats.length > 1 ? "s" : ""}`}
              </button>
            )}
          </div>
          <div className="gc-chat-banner-body nowheel">{latestChat.summary}</div>
          {chatHistoryOpen && earlierChats.length > 0 && (
            <ul className="gc-chat-history nowheel">
              {earlierChats.map((c) => (
                <li key={c.chat_id}>
                  <span className="gc-chat-banner-tag dim">{c.outcome}</span>
                  <span className="gc-chat-history-body">{c.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="gc-branches">
        {node.branches.map((b) => (
          <BranchRow
            key={b.id}
            branch={b}
            chosen={b.id === chosenId}
            removed={removedSet.has(b.id)}
            onPick={send}
            pending={isPending && !committed && !redirected}
            committed={committed}
          />
        ))}
        {isPending && !committed && !redirected && (
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
        {isPending && !committed && !redirected && (
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
                <li key={i} className={t.chat_tag ? "chat" : ""}>
                  <code>{t.tool_name || t.hook_event_name}</code>
                  {t.chat_tag && <span className="gc-hook-chat-tag">chat</span>}
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
  chosen,
  removed,
  onPick,
  pending,
  committed,
}: {
  branch: Branch;
  chosen: boolean;
  removed: boolean;
  onPick: (a: "next" | "other" | "chat", bid?: string, note?: string) => void;
  pending: boolean;
  committed: boolean;
}) {
  const [showRationale, setShowRationale] = useState(false);
  const stateClass = chosen
    ? "state-chosen"
    : removed
      ? "state-removed"
      : "";
  const glyph = chosen ? "●" : removed ? "✕" : "·";
  return (
    <div
      className={`gc-branch ${stateClass} ${branch.is_recommended ? "recommended" : ""}`}
    >
      <Handle
        type="source"
        position={Position.Right}
        id={branch.id}
        style={{ top: "50%", right: -6 }}
      />
      <div className="gc-branch-row">
        <span
          className="gc-branch-glyph"
          title={chosen ? "chosen" : removed ? "removed via chat" : "considered"}
        >
          {glyph}
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
      {!committed && !removed && (
        <div className="gc-branch-actions">
          {chosen ? (
            <span className="gc-dim">picked</span>
          ) : pending ? (
            <>
              <button className="gc-btn primary" onClick={() => onPick("next", branch.id)}>
                pick →
              </button>
              <button
                className="gc-btn ghost"
                onClick={() => onPick("chat", branch.id)}
                title="Pause grill, chat about THIS option in CC"
              >
                chat
              </button>
            </>
          ) : null}
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

function ChatIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 3h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6.5l-3 2.5V12H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    </svg>
  );
}
