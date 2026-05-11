import type { KeyboardEvent, MouseEvent } from "react";
import { useSession } from "../SessionContext";
import { HistoryEntry } from "./HistoryEntry";

interface Props {
  open: boolean;
  selectedNodeId: string | null;
  onSelect: (id: string | null) => void;
}

export function SidebarHistory({ open, selectedNodeId, onSelect }: Props) {
  const { state } = useSession();
  if (!open) return null;

  // effective row currently shown in BigCard
  const effective = selectedNodeId ?? state.pendingNodeId;

  // skip clicks originating in nested interactive elements (details summary, chat toggle, links)
  const swallowed = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return !!target.closest("button, a, summary, input, textarea, label");
  };

  return (
    <div className="gc-sidebar open">
      <header className="gc-sidebar-head">
        <span className="gc-sidebar-title">history ({state.nodeOrder.length})</span>
      </header>
      <ol className="gc-sidebar-feed">
        {state.nodeOrder.length === 0 ? (
          <li className="gc-dim gc-sidebar-empty">no decisions yet</li>
        ) : (
          state.nodeOrder.map((nid) => {
            const n = state.nodes[nid];
            if (!n) return null;
            const isPending = nid === state.pendingNodeId;
            const isSelected = nid === effective;
            const target = isPending ? null : nid;
            const classes = [
              "gc-sidebar-row",
              isPending ? "live" : "",
              isSelected ? "selected" : "",
            ]
              .filter(Boolean)
              .join(" ");
            const onClick = (e: MouseEvent) => {
              if (swallowed(e.target)) return;
              onSelect(target);
            };
            const onKeyDown = (e: KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              if (swallowed(e.target)) return;
              e.preventDefault();
              onSelect(target);
            };
            return (
              <li key={nid}>
                <div
                  role="button"
                  tabIndex={0}
                  className={classes}
                  aria-pressed={isSelected}
                  aria-label={
                    isPending
                      ? "view current question"
                      : n.kind === "summary"
                      ? "view summary"
                      : `view decision: ${n.question ?? ""}`
                  }
                  onClick={onClick}
                  onKeyDown={onKeyDown}
                >
                  <HistoryEntry node={n} />
                </div>
              </li>
            );
          })
        )}
      </ol>
    </div>
  );
}
