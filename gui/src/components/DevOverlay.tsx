import { useEffect, useRef, useState } from "react";
import { useSession } from "../SessionContext";

// Functional debug surface for the speculative sideways queue (ADR-0010).
// No production styling effort — inline styles, fixed-positioned card.
// Shows: parked queue hints (slot_id + one-line previews), hit-rate counter
// since mount, eviction log. Subscribes to live state via the reducer that
// already consumes `parked_queue_updated` SSE events.

interface Props {
  onClose: () => void;
}

interface EvictionEntry {
  ts: number;
  slot_id: string;
  question_oneline: string;
}

export function DevOverlay({ onClose }: Props) {
  const { state } = useSession();
  const slots = state.parkedSlots;

  // hit-rate counter — `consumes` increments when a slot vanishes between
  // renders (proxy for `present_parked` calls landing). Naive but matches
  // the plan: parked_consume / total_commits since mount.
  const lastSlotsRef = useRef(slots);
  const [consumes, setConsumes] = useState(0);
  const [enqueues, setEnqueues] = useState(0);
  const [evictions, setEvictions] = useState<EvictionEntry[]>([]);

  // Commit counter: tally each node_committed broadcast since mount via
  // node count growth as a cheap proxy (nodeOrder length monotonic).
  const startCommitsRef = useRef(state.nodeOrder.length);
  const totalCommits = Math.max(0, state.nodeOrder.length - startCommitsRef.current);

  useEffect(() => {
    const prev = lastSlotsRef.current;
    const prevIds = new Set(prev.map((s) => s.slot_id));
    const curIds = new Set(slots.map((s) => s.slot_id));
    // disappeared = consume OR evict-by-replace. Replace = both prev had it
    // AND prev was non-empty AND new set unrelated. Cheap heuristic.
    const gone = prev.filter((s) => !curIds.has(s.slot_id));
    if (gone.length > 0) {
      // If exactly one slot disappeared and the rest line up, count consume.
      // Anything else looks like a replace — log as eviction.
      const oneGone = gone.length === 1 && slots.length === prev.length - 1;
      if (oneGone) {
        setConsumes((c) => c + 1);
      } else {
        const now = Date.now();
        setEvictions((ev) => [
          ...gone.map((g) => ({ ts: now, slot_id: g.slot_id, question_oneline: g.question_oneline })),
          ...ev,
        ].slice(0, 20));
      }
    }
    const added = slots.filter((s) => !prevIds.has(s.slot_id));
    if (added.length > 0) setEnqueues((e) => e + added.length);
    lastSlotsRef.current = slots;
  }, [slots]);

  const hitRate = totalCommits > 0 ? consumes / totalCommits : 0;

  return (
    <div
      style={{
        position: "fixed",
        top: 70,
        right: 16,
        width: 320,
        maxHeight: "70vh",
        overflowY: "auto",
        background: "rgba(20, 22, 28, 0.96)",
        color: "#e5e7eb",
        border: "1px solid #374151",
        borderRadius: 8,
        boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
        zIndex: 9999,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        padding: 12,
      }}
      role="dialog"
      aria-label="Speculation dev overlay"
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Speculation (dev)</strong>
        <button
          type="button"
          onClick={onClose}
          style={{ background: "transparent", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 16 }}
          aria-label="close dev overlay"
        >
          ×
        </button>
      </div>

      <section style={{ marginBottom: 10 }}>
        <div style={{ color: "#9ca3af", marginBottom: 4 }}>Queue ({slots.length})</div>
        {slots.length === 0 && <div style={{ color: "#6b7280" }}>empty</div>}
        {slots.map((s) => (
          <div key={s.slot_id} style={{ marginBottom: 4, lineHeight: 1.3 }}>
            <span style={{ color: "#60a5fa" }}>{s.slot_id.slice(0, 8)}</span>{" "}
            <span>{s.question_oneline}</span>
          </div>
        ))}
      </section>

      <section style={{ marginBottom: 10 }}>
        <div style={{ color: "#9ca3af", marginBottom: 4 }}>Hit rate</div>
        <div>
          consumes {consumes} / commits {totalCommits} ={" "}
          <strong>{(hitRate * 100).toFixed(0)}%</strong>
        </div>
        <div style={{ color: "#6b7280" }}>enqueued total: {enqueues}</div>
      </section>

      <section>
        <div style={{ color: "#9ca3af", marginBottom: 4 }}>Evictions (last {evictions.length})</div>
        {evictions.length === 0 && <div style={{ color: "#6b7280" }}>none</div>}
        {evictions.map((e, i) => (
          <div key={`${e.slot_id}-${i}`} style={{ marginBottom: 3, color: "#fca5a5" }}>
            <span>{e.slot_id.slice(0, 8)}</span> {e.question_oneline}
          </div>
        ))}
      </section>
    </div>
  );
}
