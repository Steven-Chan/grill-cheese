import { useMemo } from "react";
import { useSession } from "../SessionContext";

// Honest progress bar (ADR-0007).
// Reads the latest non-implicit node's progress field. Animates honestly —
// shrinks allowed. Absent value hides the bar entirely. No tooltip, no readout.
export function ProgressBar() {
  const { state } = useSession();
  const latest = useMemo(() => {
    for (let i = state.nodeOrder.length - 1; i >= 0; i--) {
      const n = state.nodes[state.nodeOrder[i]];
      if (!n || n.implicit) continue;
      return n;
    }
    return null;
  }, [state.nodes, state.nodeOrder]);

  // ADR-0007 scope: open-session only. Ended sessions hide the bar — the
  // ScoreChip + verdict already convey "done"; a static 100% bar is dead
  // pixels. The summary card's 1.0 still flashes during the active→ended
  // transition (status flips after the verdict click).
  if (!state.loaded || !latest || state.status !== "active") return null;

  const p = latest.progress;
  const hasValue = typeof p === "number" && Number.isFinite(p);
  if (!hasValue) return null;
  const pct = Math.max(0, Math.min(1, p as number)) * 100;

  return (
    <div className="gc-progress-bar" role="presentation" aria-hidden="true">
      <div className="gc-progress-bar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
