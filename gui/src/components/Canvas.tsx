import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useStore } from "../store";
import { NODE_H, NODE_W, SUMMARY_H, SUMMARY_W, layoutTree, type NodeSize } from "../layout";
import { DecisionNode as DecisionNodeView } from "./DecisionNode";
import { SummaryNode as SummaryNodeView } from "./SummaryNode";

const nodeTypes = { decision: DecisionNodeView, summary: SummaryNodeView };
const FOCUS_DURATION_MS = 500;

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

function CanvasInner() {
  const nodes = useStore((s) => s.nodes);
  const pendingNodeId = useStore((s) => s.pendingNodeId);
  const userPanned = useStore((s) => s.userPanned);
  const setUserPanned = useStore((s) => s.setUserPanned);
  const panEnabled = useStore((s) => s.panEnabled);
  const setPanEnabled = useStore((s) => s.setPanEnabled);
  const rf = useReactFlow();
  // ref guards against re-firing setCenter on `node_updated` SSE events
  // (which mutate `nodes` → `rfNodes` recomputes → effect re-runs while
  // pendingNodeId is unchanged). Focus must fire once per new pending node.
  const lastFocusedId = useRef<string | null>(null);
  // swallow next onMoveStart — programmatic setCenter triggers it too in xyflow,
  // which would falsely flip userPanned=true and light up the active-state FAB.
  const programmaticMove = useRef(false);
  // safety timer: clears flag if onMoveStart never fires (no-op setCenter).
  const programmaticTimer = useRef<number | null>(null);

  // First-measure dynamic sizing. xyflow measures the rendered DOM and
  // exposes dims via getInternalNode().measured. We rAF-poll once per
  // new node id, snapshot into this map, then never re-measure — so
  // mid-grill toggles (rationale, hooks list) don't reshuffle layout.
  const [measuredSizes, setMeasuredSizes] = useState<Record<string, NodeSize>>({});
  const measuringIds = useRef<Set<string>>(new Set());

  const { rfNodes, rfEdges } = useMemo(() => {
    const visible = Object.values(nodes);
    const flowNodes: Node[] = visible.map((n) => ({
      id: n.id,
      type: n.kind === "summary" ? "summary" : "decision",
      position: { x: 0, y: 0 },
      data: { node: n, isPending: pendingNodeId === n.id },
      // dagre layoutTree is authoritative; manual drags get wiped on next push
      draggable: false,
    }));
    const flowEdges: Edge[] = [];
    const visibleIds = new Set(visible.map((n) => n.id));
    for (const n of visible) {
      const removedSet = new Set(n.removed_branch_ids ?? []);
      for (const b of n.branches) {
        if (b.child_node_id && visibleIds.has(b.child_node_id)) {
          const isChosenPath = b.id === n.chosen_branch_id;
          const isRemoved = removedSet.has(b.id);
          // redirect edges (chatted node abandoned) carry a special label
          const isRedirectEdge = !!n.redirected;
          const edgeLabel = isRedirectEdge ? `redirected: ${b.label}` : b.label;
          flowEdges.push({
            id: `${n.id}:${b.id}`,
            source: n.id,
            sourceHandle: b.id,
            target: b.child_node_id,
            label: edgeLabel,
            animated: isChosenPath || isRedirectEdge,
            style: {
              stroke: isChosenPath
                ? "var(--gc-accent)"
                : isRedirectEdge
                  ? "var(--gc-impl)"
                  : "var(--gc-edge)",
              strokeWidth: isChosenPath || isRedirectEdge ? 2 : 1,
              opacity: isRemoved ? 0.25 : 1,
              strokeDasharray: isRedirectEdge ? "6 4" : undefined,
            },
            labelStyle: { fontSize: 11, fontFamily: "var(--gc-mono)" },
          });
        }
      }
    }
    const nodeSizes: Record<string, NodeSize> = {};
    for (const n of visible) {
      const measured = measuredSizes[n.id];
      nodeSizes[n.id] = measured ?? (n.kind === "summary"
        ? { w: SUMMARY_W, h: SUMMARY_H }
        : { w: NODE_W, h: NODE_H });
    }
    const laid = layoutTree(flowNodes, flowEdges, nodeSizes);
    return { rfNodes: laid.nodes, rfEdges: laid.edges };
  }, [nodes, pendingNodeId, measuredSizes]);

  // Snapshot measured dims for any node we haven't sized yet. rAF-polls
  // until xyflow's nodeLookup has measured.{w,h} populated, writes once,
  // never again — re-layout fires exactly once per new node id.
  // Cleanup cancels in-flight rAFs on unmount; functional setState reads
  // fresh state so measuredSizes is intentionally NOT in deps (else every
  // measurement write re-runs this effect).
  useEffect(() => {
    const pendingRafs = new Map<string, number>();
    const ids = Object.keys(nodes);
    for (const id of ids) {
      if (measuringIds.current.has(id)) continue;
      measuringIds.current.add(id);
      const tryMeasure = () => {
        const ni = rf.getInternalNode(id);
        const w = ni?.measured?.width;
        const h = ni?.measured?.height;
        if (!ni || !w || !h) {
          pendingRafs.set(id, requestAnimationFrame(tryMeasure));
          return;
        }
        pendingRafs.delete(id);
        setMeasuredSizes((prev) => {
          if (prev[id]) {
            measuringIds.current.delete(id);
            return prev;
          }
          measuringIds.current.delete(id);
          return { ...prev, [id]: { w, h } };
        });
      };
      tryMeasure();
    }
    return () => {
      // Cancel in-flight rAFs and release their ids from the dedupe set
      // so a subsequent effect run can re-attempt measurement.
      for (const [id, handle] of pendingRafs) {
        cancelAnimationFrame(handle);
        measuringIds.current.delete(id);
      }
      pendingRafs.clear();
    };
  }, [nodes, rf]);

  // auto-focus: pan to new pending node, keep current zoom.
  // gates on measuredSizes[pendingNodeId] so we read the post-measure
  // (pass B) layout — earlier reads would land on the default-size pass A
  // position, then layout shifts and viewport is left stuck on stale spot.
  useEffect(() => {
    if (!pendingNodeId) return;
    if (pendingNodeId === lastFocusedId.current) return;
    const sz = measuredSizes[pendingNodeId];
    if (!sz) return; // wait — useMemo will re-layout once dims arrive
    // advance focused-id before the !node guard, else node-removed races
    // re-enter on every rfNodes recompute and re-arm programmaticMove,
    // swallowing real user pans inside the safety window.
    lastFocusedId.current = pendingNodeId;
    const node = rfNodes.find((n) => n.id === pendingNodeId);
    if (!node) return;
    armProgrammaticMove();
    rf.setCenter(node.position.x + sz.w / 2, node.position.y + sz.h / 2, {
      duration: FOCUS_DURATION_MS,
      zoom: rf.getZoom(),
    });
  }, [pendingNodeId, rfNodes, measuredSizes, rf]);

  // clear pending timer on unmount — stale timers across remounts would
  // reset programmaticMove at the wrong time and swallow a real user pan.
  useEffect(() => {
    return () => {
      if (programmaticTimer.current !== null) {
        window.clearTimeout(programmaticTimer.current);
        programmaticTimer.current = null;
      }
    };
  }, []);

  // arm flag + safety timeout so a no-op setCenter (already at target, or
  // coalesced w/ rapid back-to-back calls) doesn't leave it stuck true.
  const armProgrammaticMove = () => {
    programmaticMove.current = true;
    if (programmaticTimer.current !== null) {
      window.clearTimeout(programmaticTimer.current);
    }
    programmaticTimer.current = window.setTimeout(() => {
      programmaticMove.current = false;
      programmaticTimer.current = null;
    }, FOCUS_DURATION_MS + 50);
  };

  // last node = most recently created. Recenter target regardless of pending.
  const lastNodeId = useMemo(() => {
    let bestId: string | null = null;
    let bestT = -Infinity;
    for (const n of Object.values(nodes)) {
      if (n.created_at > bestT) {
        bestT = n.created_at;
        bestId = n.id;
      }
    }
    return bestId;
  }, [nodes]);

  const jumpToLast = () => {
    if (!lastNodeId) return;
    const node = rf.getInternalNode(lastNodeId);
    if (!node) return;
    const w = node.measured?.width ?? NODE_W;
    const h = node.measured?.height ?? NODE_H;
    setUserPanned(false);
    armProgrammaticMove();
    rf.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
      duration: FOCUS_DURATION_MS,
      zoom: rf.getZoom(),
    });
  };

  // onMoveStart fires for programmatic setCenter too — swallow that one
  // via programmaticMove ref so userPanned only flips on real user gestures.
  const handleMoveStart = () => {
    if (programmaticMove.current) {
      programmaticMove.current = false;
      if (programmaticTimer.current !== null) {
        window.clearTimeout(programmaticTimer.current);
        programmaticTimer.current = null;
      }
      return;
    }
    setUserPanned(true);
  };

  const isActive = userPanned;

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      fitView
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: "smoothstep" }}
      onMoveStart={handleMoveStart}
      panOnDrag={panEnabled}
      nodesDraggable={false}
    >
      <Background gap={32} size={1} color="var(--gc-grid)" />
      <Controls />
      <Panel position="bottom-right">
        <div className="gc-fab-stack">
          <button
            className={`gc-pan-btn${panEnabled ? " active" : ""}`}
            onClick={() => setPanEnabled(!panEnabled)}
            aria-label={panEnabled ? "Lock canvas (disable drag-to-pan)" : "Unlock canvas (enable drag-to-pan)"}
            title={panEnabled ? "Disable drag-to-pan" : "Enable drag-to-pan"}
            aria-pressed={panEnabled}
          >
            <PanIcon enabled={panEnabled} />
          </button>
          <button
            className={`gc-jump-btn${isActive ? " active" : ""}`}
            onClick={jumpToLast}
            disabled={!lastNodeId}
            aria-label="Recenter on latest node"
            title="Recenter on latest node"
          >
            <RecenterIcon />
          </button>
        </div>
      </Panel>
    </ReactFlow>
  );
}

// Hand glyph (active) / locked-hand (inactive) — toggles drag-to-pan.
function PanIcon({ enabled }: { enabled: boolean }) {
  if (enabled) {
    // Open hand — pan active
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11" />
        <path d="M12 11V4a1.5 1.5 0 0 1 3 0v7" />
        <path d="M15 11V5.5a1.5 1.5 0 0 1 3 0V14" />
        <path d="M9 11V8a1.5 1.5 0 0 0-3 0v8a6 6 0 0 0 6 6h1a6 6 0 0 0 6-6v-2" />
      </svg>
    );
  }
  // Padlock — pan locked
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

// Material `my_location` glyph — crosshair with center dot.
function RecenterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="7" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
    </svg>
  );
}
