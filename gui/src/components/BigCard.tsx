import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { postAction, type ActionKind, type ActionRejection } from "../api";
import { useSession } from "../SessionContext";
import type { DecisionNode } from "../types";

interface Props {
  onToast: (msg: string) => void;
}

export function BigCard({ onToast }: Props) {
  const { state } = useSession();
  if (!state.pendingNodeId) {
    return (
      <div className="gc-bigcard gc-bigcard-idle">
        <p className="gc-dim">waiting for the next question…</p>
      </div>
    );
  }
  const node = state.nodes[state.pendingNodeId];
  if (!node) return null;
  return node.kind === "summary" ? (
    <SummaryCard key={node.id} node={node} sid={state.sid} onToast={onToast} />
  ) : (
    <DecisionCard
      key={node.id}
      node={node}
      sid={state.sid}
      onToast={onToast}
      paused={state.status === "paused"}
    />
  );
}

// ---------- decision card ----------

function DecisionCard({
  node,
  sid,
  onToast,
  paused,
}: {
  node: DecisionNode;
  sid: string;
  onToast: (msg: string) => void;
  paused: boolean;
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

  const canSubmit = picked.size > 0 || note.trim().length > 0;
  // chat-resolve sets chosen_branch_ids server-side without flipping `committed`
  // in our reducer, so treat any "already-answered" node as locked too.
  const locked = !!node.committed || (node.chosen_branch_ids ?? []).length > 0;

  const send = async (action: ActionKind, opts?: { skipPicks?: boolean }) => {
    if (busy) return;
    setBusy(action);
    try {
      await postAction(sid, node.id, action, {
        branch_ids: opts?.skipPicks ? [] : Array.from(picked),
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
      </ul>

      <div className="gc-bigcard-note">
        <textarea
          rows={2}
          placeholder="or type your own answer / redirect…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={locked}
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
          <button
            type="button"
            className="gc-btn gc-btn-secondary"
            disabled={locked || !!busy}
            onClick={() => send("stop", { skipPicks: true })}
            title="Wrap up the session — Claude will draft a summary"
          >
            Wrap up
          </button>
        </div>
      </div>

      {paused && (
        <div className="gc-bigcard-paused-banner">
          <strong>paused</strong> — chatting in Claude Code about this question.
        </div>
      )}
      {locked && !paused && (
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
}: {
  node: DecisionNode;
  sid: string;
  onToast: (msg: string) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const docsBlocked = !!node.generate_docs;
  const locked = !!node.committed || (node.chosen_branch_ids ?? []).length > 0;

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
