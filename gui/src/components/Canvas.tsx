import { useEffect, useMemo, useRef } from "react";
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

  const { rfNodes, rfEdges } = useMemo(() => {
    const visible = Object.values(nodes);
    const flowNodes: Node[] = visible.map((n) => ({
      id: n.id,
      type: n.kind === "summary" ? "summary" : "decision",
      position: { x: 0, y: 0 },
      data: { node: n, isPending: pendingNodeId === n.id },
      draggable: true,
    }));
    const flowEdges: Edge[] = [];
    const visibleIds = new Set(visible.map((n) => n.id));
    for (const n of visible) {
      for (const b of n.branches) {
        if (b.child_node_id && visibleIds.has(b.child_node_id)) {
          const isChosenPath = b.state === "chosen";
          flowEdges.push({
            id: `${n.id}:${b.id}`,
            source: n.id,
            sourceHandle: b.id,
            target: b.child_node_id,
            label: b.label,
            animated: isChosenPath,
            style: {
              stroke: isChosenPath ? "var(--gc-accent)" : "var(--gc-edge)",
              strokeWidth: isChosenPath ? 2 : 1,
              opacity: b.state === "rejected" ? 0.25 : 1,
            },
            labelStyle: { fontSize: 11, fontFamily: "var(--gc-mono)" },
          });
        }
      }
    }
    const nodeSizes: Record<string, NodeSize> = {};
    for (const n of visible) {
      nodeSizes[n.id] = n.kind === "summary"
        ? { w: SUMMARY_W, h: SUMMARY_H }
        : { w: NODE_W, h: NODE_H };
    }
    const laid = layoutTree(flowNodes, flowEdges, nodeSizes);
    return { rfNodes: laid.nodes, rfEdges: laid.edges };
  }, [nodes, pendingNodeId]);

  // auto-focus: pan to new pending node, keep current zoom.
  // fires once per new pendingNodeId. measured dims live on xyflow's internal
  // node (nodeLookup) — rf.getNode() reads the raw prop array which never gets
  // measured. rf.getInternalNode() reads nodeLookup. rAF-poll until ready.
  useEffect(() => {
    if (!pendingNodeId) return;
    if (pendingNodeId === lastFocusedId.current) return;
    let cancelled = false;
    let raf = 0;
    const tryFocus = () => {
      if (cancelled) return;
      const node = rf.getInternalNode(pendingNodeId);
      const w = node?.measured?.width;
      const h = node?.measured?.height;
      if (!node || !w || !h) {
        raf = requestAnimationFrame(tryFocus);
        return;
      }
      lastFocusedId.current = pendingNodeId;
      armProgrammaticMove();
      rf.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
        duration: FOCUS_DURATION_MS,
        zoom: rf.getZoom(),
      });
    };
    tryFocus();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [pendingNodeId, rf]);

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

  const jumpToPending = () => {
    if (!pendingNodeId) return;
    const node = rf.getInternalNode(pendingNodeId);
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

  const showJump = pendingNodeId !== null;
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
    >
      <Background gap={32} size={1} color="var(--gc-grid)" />
      <Controls />
      {showJump && (
        <Panel position="top-right">
          <button
            className={`gc-jump-btn${isActive ? " active" : ""}`}
            onClick={jumpToPending}
            aria-label="Recenter on current question"
            title="Recenter on current question"
          >
            <RecenterIcon />
          </button>
        </Panel>
      )}
    </ReactFlow>
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
