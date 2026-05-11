import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { postAction, type ActionKind, type ActionRejection } from "../api";
import { useSession } from "../SessionContext";
import type { DecisionNode } from "../types";
import { HistoryEntry } from "./HistoryEntry";

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
          className="gc-btn gc-btn-primary"
          disabled={locked || !canSubmit || !!busy}
          onClick={() => send("next")}
        >
          {busy === "next" ? "sending…" : "Next"}
        </button>
        <div className="gc-bigcard-footer">
          <button
            type="button"
            className="gc-btn gc-btn-secondary"
            disabled={locked || !!busy}
            onClick={() => send("chat", { skipPicks: true })}
            title="Pause and chat about this question in Claude Code"
          >
            Chat
          </button>
        </div>
      </div>

      {paused && (
        <div className="gc-bigcard-paused-banner">
          <strong>paused</strong> — chatting in Claude Code about this question.
        </div>
      )}
      {!!node.committed && !paused && (
        <div className="gc-bigcard-locked-banner gc-dim">
          settled — waiting for the next question…
        </div>
      )}
    </article>
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
    </article>
  );
}
