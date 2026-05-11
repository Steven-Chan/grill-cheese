import { useSession } from "../SessionContext";
import { HistoryEntry } from "./HistoryEntry";

interface Props {
  open: boolean;
}

export function SidebarHistory({ open }: Props) {
  const { state } = useSession();
  if (!open) return null;

  // exclude the currently-pending node (it lives in the BigCard)
  const past = state.nodeOrder.filter((id) => id !== state.pendingNodeId);

  return (
    <div className="gc-sidebar open">
      <header className="gc-sidebar-head">
        <span className="gc-sidebar-title">history ({past.length})</span>
      </header>
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
    </div>
  );
}
