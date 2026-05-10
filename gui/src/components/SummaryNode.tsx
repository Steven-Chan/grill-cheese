import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import type { DecisionNode as DNode } from "../types";
import { postAction, type ActionKind } from "../api";
import { useStore } from "../store";

interface Data {
  node: DNode;
  isPending: boolean;
}

type SummaryAction = "stop_here" | "create_plan" | "implement_now" | "continue_grill";

interface ButtonSpec {
  action: SummaryAction;
  label: string;
  cls: string;
  title: string;
}

// Order: continue first (most-likely mid-grill), then plan, code, stop.
const BUTTONS: ButtonSpec[] = [
  {
    action: "continue_grill",
    label: "continue grilling",
    cls: "primary",
    title: "Keep grilling — pushes another question (uses note as redirect)",
  },
  {
    action: "create_plan",
    label: "create plan",
    cls: "ghost",
    title: "Approve decisions; Claude writes a detailed implementation plan first",
  },
  {
    action: "implement_now",
    label: "implement now",
    cls: "ghost",
    title: "Approve decisions; Claude starts coding immediately",
  },
  {
    action: "stop_here",
    label: "stop here",
    cls: "warn",
    title: "Approve, no follow-up. Session ends.",
  },
];

export function SummaryNode({ data }: NodeProps) {
  const { node, isPending } = data as unknown as Data;
  const sid = useStore((s) => s.activeSessionId);
  const hydratedAt = useStore((s) => s.sessionHydratedAt);
  const isFresh = node.created_at >= hydratedAt;
  const [noteText, setNoteText] = useState("");
  const committed = !!node.committed;

  // Synthetic continuation branch is appended in-place by apply_action on
  // continue_grill — surfaces here as the only branch on the node.
  const contBranch = node.branches[0];
  // committed_action is set by the node_committed SSE handler — carries the
  // exact verdict (stop_here / create_plan / implement_now / continue_grill)
  // so we can highlight the right button after commit.
  const chosenAction: SummaryAction | null =
    committed && node.committed_action
      ? (node.committed_action as SummaryAction)
      : null;

  const send = async (action: SummaryAction) => {
    if (!sid) return;
    const note = action === "continue_grill" ? noteText.trim() || undefined : undefined;
    try {
      await postAction(sid, node.id, action as ActionKind, { note });
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className={`gc-summary-node ${isPending && !committed ? "pending" : ""} ${committed ? "committed" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="gc-node-inner" data-fresh={isFresh ? "true" : "false"}>
      <div className="gc-summary-head">
        <span className="gc-node-tag">summary</span>
        {isPending && !committed && <span className="gc-node-tag pulse">awaiting verdict</span>}
        {committed && <span className="gc-node-tag">settled</span>}
      </div>
      <div className="gc-summary-body nowheel">
        {node.summary_body ? (
          <ReactMarkdown>{node.summary_body}</ReactMarkdown>
        ) : (
          <em className="gc-dim">no summary text</em>
        )}
      </div>
      <div className="gc-summary-actions">
        <textarea
          className="gc-other-input gc-summary-note"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Optional note for 'continue grilling' — what to drill into next."
          rows={2}
          disabled={committed}
        />
        <div className="gc-summary-btns">
          {BUTTONS.map((b) => {
            const isPicked = chosenAction === b.action;
            return (
              <button
                key={b.action}
                className={`gc-btn ${b.cls} ${isPicked ? "picked" : ""}`}
                onClick={() => send(b.action)}
                disabled={committed}
                title={b.title}
              >
                {b.label}
                {isPicked && " ✓"}
              </button>
            );
          })}
        </div>
      </div>
      </div>
      {/* Source handle for the synthetic continuation branch — only meaningful
          after continue_grill commits and the branch exists. */}
      {contBranch && (
        <Handle
          type="source"
          position={Position.Right}
          id={contBranch.id}
          style={{ top: "50%", right: -6 }}
        />
      )}
    </div>
  );
}
