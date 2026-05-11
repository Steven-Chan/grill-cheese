import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { postAction, type ActionKind, type ActionRejection } from "../api";
import { useSession } from "../SessionContext";
import type { ChatMessage, DecisionNode, PendingProposal } from "../types";
import { HistoryEntry } from "./HistoryEntry";

// uuid for chat_id / msg_id. crypto.randomUUID() is available in all
// browsers we target (Chrome/Edge/FF/Safari from 2022 onward) and in
// secure contexts only — localhost qualifies.
function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

interface Props {
  onToast: (msg: string) => void;
  selectedNodeId: string | null;
  onClearSelection: () => void;
}

export function BigCard({ onToast, selectedNodeId, onClearSelection }: Props) {
  const { state } = useSession();

  // if pinned to a past node AND it's not the current pending, render read-only view
  if (selectedNodeId && selectedNodeId !== state.pendingNodeId) {
    const pinned = state.nodes[selectedNodeId];
    if (!pinned) return null;
    return (
      <div className="gc-bigcard-pastview">
        <button
          type="button"
          className="gc-btn gc-btn-toolbar gc-pastview-back"
          onClick={onClearSelection}
        >
          ← back to current question
        </button>
        <HistoryEntry node={pinned} expanded />
      </div>
    );
  }

  // when there's no live pending question, keep the most recent card on screen
  // (force-locked) so the view doesn't flash to a placeholder between submit
  // and the next node arriving over SSE. Skip implicit (silent record-only)
  // and redirected (settled-via-chat) nodes — neither should resurface as
  // the visible card.
  let pendingId = state.pendingNodeId;
  const fromFallback = !pendingId;
  if (!pendingId) {
    for (let i = state.nodeOrder.length - 1; i >= 0; i--) {
      const id = state.nodeOrder[i];
      const n = state.nodes[id];
      if (!n) continue;
      if (n.implicit) continue;
      if (n.redirected) continue;
      pendingId = id;
      break;
    }
  }
  if (!pendingId) {
    return (
      <div className="gc-bigcard gc-bigcard-idle">
        <p className="gc-dim">waiting for the next question…</p>
      </div>
    );
  }
  const node = state.nodes[pendingId];
  if (!node) return null;
  return node.kind === "summary" ? (
    <SummaryCard key={node.id} node={node} sid={state.sid} onToast={onToast} forceLocked={fromFallback} />
  ) : (
    <DecisionCard
      key={node.id}
      node={node}
      sid={state.sid}
      onToast={onToast}
      paused={state.status === "paused"}
      forceLocked={fromFallback}
    />
  );
}

// ---------- decision card ----------

// sentinel id for the single-mode "Other" radio. Never sent to server — when
// picked, branch_ids = [] and the note becomes the user-authored answer.
const OTHER_PICK = "__other__";

function DecisionCard({
  node,
  sid,
  onToast,
  paused,
  forceLocked,
}: {
  node: DecisionNode;
  sid: string;
  onToast: (msg: string) => void;
  paused: boolean;
  forceLocked?: boolean;
}) {
  const multi = !!node.multi_select;
  const removed = useMemo(() => new Set(node.removed_branch_ids ?? []), [node.removed_branch_ids]);
  const live = useMemo(() => node.branches.filter((b) => !removed.has(b.id)), [node.branches, removed]);

  // initial selection: in multi-mode pre-check all is_recommended; single-mode pre-pick the recommended.
  const [picked, setPicked] = useState<Set<string>>(() => {
    const s = new Set<string>();
    if (multi) {
      for (const b of live) if (b.is_recommended) s.add(b.id);
    }
    return s;
  });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<ActionKind | null>(null);

  // reset selection when node identity changes
  useEffect(() => {
    setPicked(() => {
      const s = new Set<string>();
      if (multi) {
        for (const b of live) if (b.is_recommended) s.add(b.id);
      }
      return s;
    });
    setNote("");
  }, [node.id, multi, live]);

  const togglePick = (id: string) => {
    if (multi) {
      setPicked((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      setPicked(new Set([id]));
    }
  };

  // single-mode: "Other" radio routes the typed note as the answer
  const otherPicked = !multi && picked.has(OTHER_PICK);
  const noteEnabled = multi || otherPicked;
  const canSubmit = multi
    ? picked.size > 0 || note.trim().length > 0
    : otherPicked
      ? note.trim().length > 0
      : picked.size > 0;
  // chat-resolve sets chosen_branch_ids server-side without flipping `committed`
  // in our reducer, so treat any "already-answered" node as locked too.
  // forceLocked covers the fallback-render case (no live pending, view kept on
  // last card) where local committed/chosen state may not have caught up yet
  // with the SSE event for the just-submitted action.
  const locked = !!forceLocked || !!node.committed || (node.chosen_branch_ids ?? []).length > 0;

  const send = async (action: ActionKind, opts?: { skipPicks?: boolean }) => {
    if (busy) return;
    setBusy(action);
    try {
      const branch_ids = opts?.skipPicks
        ? []
        : Array.from(picked).filter((id) => id !== OTHER_PICK);
      await postAction(sid, node.id, action, {
        branch_ids,
        note: note.trim() || undefined,
      });
    } catch (e) {
      const rej = e as ActionRejection;
      if (rej && typeof rej.status === "number") {
        if (rej.err === "branch_removed") onToast("This option was removed in a recent chat.");
        else if (rej.err === "node locked") onToast("This question is already settled.");
        else onToast(`Action rejected: ${rej.err ?? rej.status}`);
      } else {
        onToast("Network error");
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <article className={`gc-bigcard${locked ? " locked" : ""}${paused ? " paused" : ""}`}>
        <header className="gc-bigcard-head">
          {node.multi_select && <span className="gc-chip">multi-select</span>}
          <span className="gc-dim">depth {node.depth}</span>
        </header>
        <h2 className="gc-bigcard-q">{node.question}</h2>
        {node.reasoning && <p className="gc-bigcard-reasoning">{node.reasoning}</p>}

        <ul className="gc-bigcard-branches">
          {live.map((b) => {
            const checked = picked.has(b.id);
            return (
              <li key={b.id} className={`gc-branch${checked ? " checked" : ""}${b.is_recommended ? " recommended" : ""}`}>
                <label>
                  <input
                    type={multi ? "checkbox" : "radio"}
                    name={`branch-${node.id}`}
                    checked={checked}
                    disabled={locked}
                    onChange={() => togglePick(b.id)}
                  />
                  <span className="gc-branch-text">
                    <span className="gc-branch-label">
                      {b.is_recommended && <span className="gc-star" title="recommended">★</span>} {b.label}
                    </span>
                    {b.rationale && <span className="gc-branch-rationale">{b.rationale}</span>}
                  </span>
                </label>
              </li>
            );
          })}
          {!multi && (
            <li className={`gc-branch gc-branch-other${otherPicked ? " checked" : ""}`}>
              <label>
                <input
                  type="radio"
                  name={`branch-${node.id}`}
                  checked={otherPicked}
                  disabled={locked}
                  onChange={() => togglePick(OTHER_PICK)}
                />
                <span className="gc-branch-text">
                  <span className="gc-branch-label">Other — type your own answer</span>
                </span>
              </label>
            </li>
          )}
        </ul>

        <div className="gc-bigcard-note">
          <textarea
            rows={2}
            placeholder={
              multi
                ? "or type your own answer / redirect…"
                : otherPicked
                  ? "type your answer / redirect…"
                  : "pick \"Other\" above to type your own answer"
            }
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={locked || !noteEnabled}
          />
        </div>

        <div className="gc-bigcard-actions">
          <button
            type="button"
            className="gc-btn gc-btn-secondary"
            disabled={locked || !!busy}
            onClick={() => send("chat", { skipPicks: true })}
            title="Open inline chat with Claude about this question"
          >
            Chat
          </button>
          <button
            type="button"
            className="gc-btn gc-btn-primary"
            disabled={locked || !canSubmit || !!busy}
            onClick={() => send("next")}
          >
            {busy === "next" ? "sending…" : "Next"}
          </button>
        </div>

        {!!node.committed && !paused && !node.chat_open && (
          <div className="gc-bigcard-locked-banner gc-dim">
            <span>settled — waiting for the next question…</span>
          </div>
        )}
      </article>
      {node.chat_open && (
        <ChatPanel node={node} sid={sid} onToast={onToast} />
      )}
    </>
  );
}

// ---------- inline chat panel ----------

function ChatPanel({
  node,
  sid,
  onToast,
}: {
  node: DecisionNode;
  sid: string;
  onToast: (msg: string) => void;
}) {
  const messages = node.chat_messages ?? [];
  const proposals = node.pending_proposals ?? [];
  // first proposal's chat_id represents the thread; all share the same id
  const stagedChatId = proposals[0]?.chat_id ?? null;

  // chat_id: stable for this chat thread. Persist via a staged proposal
  // if one already exists (so Accept maps to the same chat_id Claude staged).
  // Otherwise generate once and keep in a ref for the panel lifetime.
  const chatIdRef = useRef<string | null>(null);
  if (chatIdRef.current === null) {
    chatIdRef.current = stagedChatId ?? uuid();
  }
  // re-sync chat_id when a proposal batch lands carrying a different one
  // (e.g. a chat was opened pre-restart and Claude staged with a different id).
  useEffect(() => {
    if (stagedChatId && stagedChatId !== chatIdRef.current) {
      chatIdRef.current = stagedChatId;
    }
  }, [stagedChatId]);

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"send" | "accept" | "close" | null>(null);
  const [pickedProposalId, setPickedProposalId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset pick when a fresh proposal batch lands (whole list replaced).
  // batchKey = joined proposal_ids → guaranteed to change across batches
  // even if back-to-back stages share a proposed_at millisecond.
  const batchKey = proposals.map((p) => p.proposal_id).join(",");
  useEffect(() => {
    if (proposals.length === 1) {
      setPickedProposalId(proposals[0].proposal_id);
    } else if (proposals.length > 1) {
      setPickedProposalId((cur) =>
        cur && proposals.some((p) => p.proposal_id === cur) ? cur : proposals[0].proposal_id,
      );
    } else {
      setPickedProposalId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchKey]);

  // autoscroll on new message
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, batchKey]);

  const send = async (text: string) => {
    if (busy) return;
    const t = text.trim();
    if (!t) return;
    setBusy("send");
    try {
      await postAction(sid, node.id, "chat_user_msg", {
        chat_id: chatIdRef.current ?? uuid(),
        msg_id: uuid(),
        text: t,
      });
      setDraft("");
    } catch (e) {
      const rej = e as ActionRejection;
      onToast(`Send failed: ${rej?.err ?? rej?.status ?? "network"}`);
    } finally {
      setBusy(null);
    }
  };

  const accept = async () => {
    if (busy || proposals.length === 0 || !pickedProposalId) return;
    setBusy("accept");
    try {
      await postAction(sid, node.id, "chat_accept", {
        chat_id: chatIdRef.current ?? stagedChatId ?? uuid(),
        proposal_id: pickedProposalId,
      });
    } catch (e) {
      const rej = e as ActionRejection;
      onToast(`Accept failed: ${rej?.err ?? rej?.status ?? "network"}`);
    } finally {
      setBusy(null);
    }
  };

  const close = async () => {
    if (busy) return;
    setBusy("close");
    try {
      await postAction(sid, node.id, "chat_close", {
        chat_id: chatIdRef.current ?? uuid(),
      });
    } catch (e) {
      const rej = e as ActionRejection;
      onToast(`Close failed: ${rej?.err ?? rej?.status ?? "network"}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="gc-chat-panel">
      <header className="gc-chat-head">
        <span className="gc-chat-title">chat</span>
        <button
          type="button"
          className="gc-btn gc-btn-toolbar gc-chat-close"
          aria-label="close chat"
          disabled={!!busy}
          onClick={close}
        >
          ×
        </button>
      </header>
      {proposals.length > 0 && (
        <ProposalPicker
          proposals={proposals}
          node={node}
          pickedId={pickedProposalId}
          onPick={setPickedProposalId}
          onAccept={accept}
          busy={busy === "accept"}
        />
      )}
      <div ref={listRef} className="gc-chat-list">
        {messages.length === 0 && (
          <p className="gc-dim gc-chat-empty">Type a message to start the chat.</p>
        )}
        {messages.map((m: ChatMessage) => (
          <div key={m.msg_id} className={`gc-chat-msg gc-chat-msg-${m.role}`}>
            <div className="gc-chat-bubble">{m.text}</div>
          </div>
        ))}
        {messages.length > 0 && messages[messages.length - 1].role === "user" && (
          <div className="gc-chat-msg gc-chat-msg-assistant" aria-label="assistant typing">
            <div className="gc-chat-bubble gc-chat-typing">
              <span /><span /><span />
            </div>
          </div>
        )}
      </div>
      <div className="gc-chat-input">
        <textarea
          rows={2}
          placeholder="type a message…"
          value={draft}
          disabled={!!busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <button
          type="button"
          className="gc-btn gc-btn-primary"
          disabled={!!busy || !draft.trim()}
          onClick={() => void send(draft)}
        >
          {busy === "send" ? "sending…" : "Send"}
        </button>
      </div>
    </section>
  );
}

function ProposalPicker({
  proposals,
  node,
  pickedId,
  onPick,
  onAccept,
  busy,
}: {
  proposals: PendingProposal[];
  node: DecisionNode;
  pickedId: string | null;
  onPick: (id: string) => void;
  onAccept: () => void;
  busy: boolean;
}) {
  const labelById = useMemo(
    () => new Map(node.branches.map((b) => [b.id, b.label] as const)),
    [node.branches],
  );
  const multi = proposals.length > 1;
  const groupName = `gc-proposal-${node.id}`;
  return (
    <div className="gc-chat-proposal">
      <header className="gc-chat-proposal-head">
        <span className="gc-chip gc-chip-proposal">
          {multi ? `proposed: pick one of ${proposals.length}` : `proposed outcome: ${proposals[0].outcome}`}
        </span>
      </header>
      <ul className="gc-chat-proposal-list" role={multi ? "radiogroup" : undefined}>
        {proposals.map((p) => {
          const checked = pickedId === p.proposal_id;
          const adds = p.ops?.adds ?? [];
          const removes = p.ops?.removes ?? [];
          return (
            <li key={p.proposal_id} className={`gc-chat-proposal-item${checked ? " is-picked" : ""}`}>
              <label className="gc-chat-proposal-row">
                <input
                  type="radio"
                  name={groupName}
                  value={p.proposal_id}
                  checked={checked}
                  disabled={busy}
                  onChange={() => onPick(p.proposal_id)}
                />
                <span className="gc-chat-proposal-body">
                  {multi && (
                    <span className="gc-chip gc-chip-proposal-mini">{p.outcome}</span>
                  )}
                  <span className="gc-chat-proposal-summary">{p.summary}</span>
                  {p.outcome === "refine" && (adds.length > 0 || removes.length > 0) && (
                    <ul className="gc-chat-proposal-ops">
                      {adds.map((b, i) => (
                        <li key={`add-${i}`} className="gc-chat-op-add">
                          + {b.label}
                          {b.rationale ? <span className="gc-dim"> — {b.rationale}</span> : null}
                        </li>
                      ))}
                      {removes.map((rid, i) => (
                        <li key={`rm-${i}`} className="gc-chat-op-remove">
                          − {labelById.get(rid) ?? rid}
                        </li>
                      ))}
                    </ul>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="gc-chat-proposal-actions">
        <button
          type="button"
          className="gc-btn gc-btn-primary"
          disabled={busy || !pickedId}
          onClick={onAccept}
        >
          {busy ? "accepting…" : "Accept"}
        </button>
      </div>
    </div>
  );
}

// ---------- summary card ----------

function SummaryCard({
  node,
  sid,
  onToast,
  forceLocked,
}: {
  node: DecisionNode;
  sid: string;
  onToast: (msg: string) => void;
  forceLocked?: boolean;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const docsBlocked = !!node.generate_docs;
  const locked = !!forceLocked || !!node.committed || (node.chosen_branch_ids ?? []).length > 0;

  const send = async (action: ActionKind) => {
    if (busy) return;
    setBusy(action);
    try {
      await postAction(sid, node.id, action, {
        note: action === "continue_grill" && note.trim() ? note.trim() : undefined,
      });
    } catch (e) {
      const rej = e as ActionRejection;
      if (rej && typeof rej.status === "number") {
        onToast(`Action rejected: ${rej.err ?? rej.status}`);
      } else {
        onToast("Network error");
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`gc-bigcard gc-summary${locked ? " locked" : ""}`}>
      <header className="gc-bigcard-head">
        <span className="gc-chip gc-chip-summary">summary</span>
        {docsBlocked && <span className="gc-chip gc-chip-docs">docs required</span>}
      </header>
      <div className="gc-summary-body">
        <ReactMarkdown>{node.summary_body ?? ""}</ReactMarkdown>
      </div>
      {docsBlocked && node.docs_reason && (
        <p className="gc-summary-docs-reason gc-dim">{node.docs_reason}</p>
      )}
      <div className="gc-summary-continue">
        <textarea
          rows={2}
          placeholder="optional — direction for continued grilling"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={locked}
        />
      </div>
      <div className="gc-summary-verdicts">
        <button
          type="button"
          className="gc-btn gc-btn-primary"
          disabled={locked || !!busy}
          onClick={() => send("create_plan")}
        >
          Create plan
        </button>
        {!docsBlocked && (
          <button
            type="button"
            className="gc-btn"
            disabled={locked || !!busy}
            onClick={() => send("implement_now")}
          >
            Implement now
          </button>
        )}
        <button
          type="button"
          className="gc-btn"
          disabled={locked || !!busy}
          onClick={() => send("stop_here")}
        >
          Stop here
        </button>
        <button
          type="button"
          className="gc-btn gc-btn-secondary"
          disabled={locked || !!busy}
          onClick={() => send("continue_grill")}
        >
          Continue grilling
        </button>
      </div>
      {locked && (
        <div className="gc-bigcard-locked-banner gc-dim">
          <span>settled.</span>
        </div>
      )}
    </article>
  );
}
