import { useEffect, useRef, useState } from "react";
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
  const hydratedAt = useStore((s) => s.sessionHydratedAt);
  const isFresh = node.created_at >= hydratedAt;
  const [hooksOpen, setHooksOpen] = useState(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);

  // pendingChecks + pendingNote: pre-submit local state. Reset on chat
  // (clean-slate-on-resume). Initialised from ★ branches once per node id.
  const [pendingChecks, setPendingChecks] = useState<Set<string>>(new Set());
  const [pendingNote, setPendingNote] = useState("");
  // single-mode only: "Other (free text)" is a mutually-exclusive radio option.
  // when true, pendingChecks is empty + submit sends note only.
  const [otherSelected, setOtherSelected] = useState(false);
  const otherInputRef = useRef<HTMLTextAreaElement | null>(null);
  const initialisedFor = useRef<string | null>(null);
  const multi = !!node.multi_select;

  useEffect(() => {
    // one-shot per node id. node.branches/multi intentionally excluded —
    // chat refine adds branches via node_updated SSE; re-initialising would
    // erase the user's mid-selection. multi_select is immutable post-creation.
    if (initialisedFor.current === node.id) return;
    initialisedFor.current = node.id;
    const recs = node.branches.filter((b) => b.is_recommended).map((b) => b.id);
    if (multi) setPendingChecks(new Set(recs));
    else setPendingChecks(recs.length > 0 ? new Set([recs[0]]) : new Set());
    setPendingNote("");
    setOtherSelected(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const committed = !!node.committed;
  const redirected = !!node.redirected;
  const chats: ChatBlock[] = node.chats ?? [];
  const removedSet = new Set(node.removed_branch_ids ?? []);
  const chosenIds = new Set(node.chosen_branch_ids ?? []);
  const latestChat = chats.length > 0 ? chats[chats.length - 1] : null;
  const earlierChats = chats.length > 1 ? chats.slice(0, -1) : [];
  const interactive = isPending && !committed && !redirected;

  const toggleCheck = (bid: string) => {
    // single-mode: picking a real branch clears "Other" radio
    if (!multi) setOtherSelected(false);
    setPendingChecks((prev) => {
      const next = new Set(prev);
      if (next.has(bid)) next.delete(bid);
      else {
        if (!multi) next.clear();
        next.add(bid);
      }
      return next;
    });
  };

  // single-mode only: select the "Other (free text)" radio
  const selectOther = () => {
    if (multi) return;
    setOtherSelected(true);
    setPendingChecks(new Set());
    // defer focus to next tick so textarea is mounted/enabled
    setTimeout(() => otherInputRef.current?.focus(), 0);
  };

  const submit = async () => {
    if (!sid) return;
    const note = pendingNote.trim();
    if (!multi) {
      // single-mode: mutually exclusive — Other radio sends note only,
      // real branch sends branch_ids only
      if (otherSelected) {
        if (!note) return;
        try {
          await postAction(sid, node.id, "next", { note });
        } catch (e) {
          console.error(e);
        }
        return;
      }
      if (pendingChecks.size === 0) return;
      try {
        await postAction(sid, node.id, "next", {
          branch_ids: Array.from(pendingChecks),
        });
      } catch (e) {
        console.error(e);
      }
      return;
    }
    // multi-mode: picks + optional note coexist
    if (pendingChecks.size === 0 && !note) return;
    try {
      await postAction(sid, node.id, "next", {
        branch_ids: Array.from(pendingChecks),
        note: note || undefined,
      });
    } catch (e) {
      console.error(e);
    }
  };

  // single-mode quick-pick: keep per-row pick→ button. Skips pendingChecks +
  // submits in one shot (matches today's UX).
  const quickPick = async (bid: string) => {
    if (!sid) return;
    try {
      await postAction(sid, node.id, "next", { branch_ids: [bid] });
    } catch (e) {
      console.error(e);
    }
  };

  const sendChat = async (bid?: string) => {
    if (!sid) return;
    setPendingChecks(new Set());
    setPendingNote("");
    setOtherSelected(false);
    try {
      await postAction(sid, node.id, "chat", { branch_id: bid });
    } catch (e) {
      console.error(e);
    }
  };

  const wrapperClasses = [
    "gc-node",
    node.implicit ? "implicit" : "",
    isPending ? "pending" : "",
    committed ? "committed" : "",
    redirected ? "redirected" : "",
    chats.length > 0 ? "chatted" : "",
    multi ? "multi" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const submitGated = multi
    ? pendingChecks.size === 0 && pendingNote.trim() === ""
    : otherSelected
      ? pendingNote.trim() === ""
      : pendingChecks.size === 0;

  return (
    <div className={wrapperClasses}>
      <Handle type="target" position={Position.Left} />
      <div className="gc-node-inner" data-fresh={isFresh ? "true" : "false"}>
      <div className="gc-node-head">
        <span className="gc-node-depth">d{node.depth}</span>
        {node.implicit && <span className="gc-node-tag">implicit</span>}
        {multi && <span className="gc-node-tag">multi</span>}
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
            chosen={chosenIds.has(b.id)}
            checked={pendingChecks.has(b.id)}
            removed={removedSet.has(b.id)}
            multi={multi}
            interactive={interactive}
            committed={committed}
            onToggle={() => toggleCheck(b.id)}
            onQuickPick={() => quickPick(b.id)}
            onChat={() => sendChat(b.id)}
          />
        ))}
        {interactive && !multi && (
          <div
            className={`gc-branch other ${otherSelected ? "state-checked" : ""}`}
            onClick={(e) => {
              // ignore clicks bubbling from the textarea
              if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
              selectOther();
            }}
            role="button"
            style={{ cursor: "pointer" }}
          >
            <div className="gc-branch-row">
              <span className="gc-branch-glyph" title="type your own answer">
                {otherSelected ? "◉" : "○"}
              </span>
              <span className="gc-branch-label">Other (type your own)</span>
            </div>
            <textarea
              ref={otherInputRef}
              className="gc-other-input nodrag"
              value={pendingNote}
              onChange={(e) => setPendingNote(e.target.value)}
              onFocus={() => {
                if (!otherSelected) selectOther();
              }}
              placeholder="Type your answer here"
              rows={2}
              style={{ marginTop: 6 }}
            />
          </div>
        )}
        {interactive && multi && (
          <div className="gc-other-box">
            <textarea
              className="gc-other-input nodrag"
              value={pendingNote}
              onChange={(e) => setPendingNote(e.target.value)}
              placeholder="Optional — add a typed answer alongside your checks"
              rows={2}
            />
          </div>
        )}
        {interactive && (
          <div className="gc-submit-row">
            <button
              className="gc-btn primary"
              onClick={submit}
              disabled={submitGated}
              title={submitGated ? "Pick at least one option or type an answer" : "Submit"}
            >
              {multi
                ? `submit${pendingChecks.size + (pendingNote.trim() ? 1 : 0) > 0 ? ` (${pendingChecks.size + (pendingNote.trim() ? 1 : 0)})` : ""}`
                : "submit →"}
            </button>
            <button
              className="gc-btn ghost"
              onClick={() => sendChat()}
              title="Pause grill, chat about this question in Claude Code"
            >
              chat about this
            </button>
          </div>
        )}
      </div>
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
    </div>
  );
}

function BranchRow({
  branch,
  chosen,
  checked,
  removed,
  multi,
  interactive,
  committed,
  onToggle,
  onQuickPick,
  onChat,
}: {
  branch: Branch;
  chosen: boolean;
  checked: boolean;
  removed: boolean;
  multi: boolean;
  interactive: boolean;
  committed: boolean;
  onToggle: () => void;
  onQuickPick: () => void;
  onChat: () => void;
}) {
  const [showRationale, setShowRationale] = useState(false);
  const stateClass = chosen
    ? "state-chosen"
    : removed
      ? "state-removed"
      : checked && interactive
        ? "state-checked"
        : "";
  // glyph: chosen wins; else removed; else multi=checkbox state; else single-mode dot
  const glyph = chosen
    ? "●"
    : removed
      ? "✕"
      : multi
        ? checked
          ? "☑"
          : "☐"
        : checked
          ? "◉"
          : "○";
  const rowDisabled = !interactive || removed;
  return (
    <div
      className={`gc-branch ${stateClass} ${branch.is_recommended ? "recommended" : ""} ${branch.user_authored ? "user-authored" : ""}`}
    >
      <Handle
        type="source"
        position={Position.Right}
        id={branch.id}
        style={{ top: "50%", right: -6 }}
      />
      <div
        className="gc-branch-row"
        onClick={() => {
          if (rowDisabled) return;
          onToggle();
        }}
        role={interactive ? "button" : undefined}
        style={interactive ? { cursor: "pointer" } : undefined}
      >
        <span
          className="gc-branch-glyph"
          title={chosen ? "chosen" : removed ? "removed via chat" : checked ? "selected" : "considered"}
        >
          {glyph}
        </span>
        <span className="gc-branch-label">
          {branch.label}
          {branch.is_recommended && <span className="gc-rec">★</span>}
          {branch.user_authored && <span className="gc-typed-tag">typed</span>}
        </span>
        {branch.rationale && !branch.user_authored && (
          <button
            type="button"
            className={`gc-branch-chevron nodrag ${showRationale ? "open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setShowRationale((o) => !o);
            }}
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
      {showRationale && branch.rationale && !branch.user_authored && (
        <div className="gc-branch-rationale">{branch.rationale}</div>
      )}
      {!committed && !removed && interactive && (
        <div className="gc-branch-actions">
          {chosen ? (
            <span className="gc-dim">picked</span>
          ) : (
            <>
              {!multi && (
                <button
                  className="gc-btn primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    onQuickPick();
                  }}
                >
                  pick →
                </button>
              )}
              <button
                className="gc-btn ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  onChat();
                }}
                title="Pause grill, chat about THIS option in CC"
              >
                chat
              </button>
            </>
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
