import { useState } from "react";
import { useSession } from "../SessionContext";
import { HistoryEntry } from "./HistoryEntry";

export function SidebarHistory() {
  const { state } = useSession();
  const [open, setOpen] = useState(true);

  // exclude the currently-pending node (it lives in the BigCard)
  const past = state.nodeOrder.filter((id) => id !== state.pendingNodeId);

  return (
    <div className={`gc-sidebar${open ? " open" : " collapsed"}`}>
      <header className="gc-sidebar-head">
        <button
          type="button"
          className="gc-sidebar-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? "▾" : "▸"} history ({past.length})
        </button>
      </header>
      {open && (
        <ol className="gc-sidebar-feed">
          {past.length === 0 ? (
            <li className="gc-dim gc-sidebar-empty">no decisions yet</li>
          ) : (
            past.map((nid) => {
              const n = state.nodes[nid];
              if (!n) return null;
              return (
                <li key={nid}>
                  <HistoryEntry node={n} />
                </li>
              );
            })
          )}
        </ol>
      )}
    </div>
  );
}
