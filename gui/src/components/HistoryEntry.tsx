import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { DecisionNode } from "../types";

interface Props {
  node: DecisionNode;
  // when true, render the entry expanded with no toggle (ended view default)
  expanded?: boolean;
}

export function HistoryEntry({ node, expanded = false }: Props) {
  const isSummary = node.kind === "summary";
  const removed = new Set(node.removed_branch_ids ?? []);
  const chosen = new Set(node.chosen_branch_ids ?? []);
  const classes = [
    "gc-history-entry",
    isSummary ? "summary" : "decision",
    node.redirected ? "redirected" : "",
    node.implicit ? "implicit" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (isSummary) {
    return (
      <article className={classes}>
        <header className="gc-entry-head">
          <span className="gc-chip gc-chip-summary">summary</span>
          {node.committed_action && (
            <span className="gc-chip gc-chip-verdict">{node.committed_action}</span>
          )}
        </header>
        <div className="gc-entry-summary-body">
          <ReactMarkdown>{node.summary_body ?? ""}</ReactMarkdown>
        </div>
      </article>
    );
  }

  return (
    <article className={classes}>
      <header className="gc-entry-head">
        {node.redirected && <span className="gc-chip gc-chip-redirected">redirected</span>}
        {node.implicit && <span className="gc-chip gc-chip-implicit">implicit</span>}
        {node.multi_select && <span className="gc-chip">multi-select</span>}
      </header>
      <h3 className="gc-entry-q">{node.question}</h3>
      {expanded && node.reasoning && <p className="gc-entry-reasoning">{node.reasoning}</p>}
      <ul className="gc-entry-picks">
        {(node.chosen_branch_ids ?? []).map((bid) => {
          const b = node.branches.find((x) => x.id === bid);
          if (!b) return null;
          return (
            <li key={bid} className={`gc-pick${b.user_authored ? " typed" : ""}`}>
              <span className="gc-pick-label">{b.label}</span>
              {b.user_authored && <span className="gc-chip gc-chip-typed">typed</span>}
            </li>
          );
        })}
      </ul>
      {expanded && (
        <ChoicesDetail node={node} chosen={chosen} removed={removed} />
      )}
      <Chats node={node} />
      {removed.size > 0 && (
        <div className="gc-entry-removed">
          <span className="gc-dim">removed via chat:</span>{" "}
          {node.branches
            .filter((b) => removed.has(b.id))
            .map((b) => (
              <span key={b.id} className="gc-removed-label">
                {b.label}
              </span>
            ))}
        </div>
      )}
    </article>
  );
}

function ChoicesDetail({
  node,
  chosen,
  removed,
}: {
  node: DecisionNode;
  chosen: Set<string>;
  removed: Set<string>;
}) {
  return (
    <details className="gc-entry-details">
      <summary className="gc-dim">all options ({node.branches.length})</summary>
      <ul className="gc-entry-options">
        {node.branches.map((b) => (
          <li
            key={b.id}
            className={[
              "gc-opt",
              chosen.has(b.id) ? "chosen" : "",
              removed.has(b.id) ? "removed" : "",
              b.is_recommended ? "recommended" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span className="gc-opt-label">
              {b.is_recommended && <span className="gc-star">★</span>} {b.label}
            </span>
            {b.rationale && <span className="gc-opt-rationale">{b.rationale}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Chats({ node }: { node: DecisionNode }) {
  const chats = node.chats ?? [];
  const [open, setOpen] = useState(false);
  if (chats.length === 0) return null;
  return (
    <div className="gc-entry-chats">
      <button
        type="button"
        className="gc-chats-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} discussed in chat ({chats.length})
      </button>
      {open && (
        <ul className="gc-chats-list">
          {chats.map((c) => (
            <li key={c.chat_id} className="gc-chat-item">
              <span className={`gc-chip gc-chip-outcome-${c.outcome}`}>{c.outcome}</span>
              <span className="gc-chat-summary">{c.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
