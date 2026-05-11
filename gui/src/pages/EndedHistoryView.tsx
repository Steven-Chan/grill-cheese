import { useSession } from "../SessionContext";
import { HistoryEntry } from "../components/HistoryEntry";

export function EndedHistoryView() {
  const { state } = useSession();
  return (
    <div className="gc-ended">
      {state.nodeOrder.length === 0 ? (
        <div className="gc-empty">empty session</div>
      ) : (
        <ol className="gc-history-feed">
          {state.nodeOrder.map((nid) => {
            const n = state.nodes[nid];
            if (!n) return null;
            return (
              <li key={nid}>
                <HistoryEntry node={n} expanded />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
