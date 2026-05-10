import { useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useStore } from "../store";
import { NODE_H, NODE_W, layoutTree } from "../layout";
import { DecisionNode as DecisionNodeView } from "./DecisionNode";

const nodeTypes = { decision: DecisionNodeView };
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
  // gate auto-focus on actual DOM measurement — layout reserves NODE_H
  // but rendered card is often taller; we need measured.height to find true center.
  const nodesInitialized = useNodesInitialized();
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
      type: "decision",
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
    const laid = layoutTree(flowNodes, flowEdges);
    return { rfNodes: laid.nodes, rfEdges: laid.edges };
  }, [nodes, pendingNodeId]);

  // auto-focus: pan to new pending node, keep current zoom.
  // fires once per new pendingNodeId — ref blocks re-runs from rfNodes changes
  // when same pending node is updated (branch tagging, hook traces, etc.).
  // waits for nodesInitialized so we can use measured.height (cards exceed NODE_H).
  useEffect(() => {
    if (!pendingNodeId) return;
    if (pendingNodeId === lastFocusedId.current) return;
    if (!nodesInitialized) return;
    const node = rf.getNode(pendingNodeId);
    if (!node) return;
    const w = node.measured?.width ?? NODE_W;
    const h = node.measured?.height ?? NODE_H;
    lastFocusedId.current = pendingNodeId;
    armProgrammaticMove();
    rf.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
      duration: FOCUS_DURATION_MS,
      zoom: rf.getZoom(),
    });
  }, [pendingNodeId, nodesInitialized, rf]);

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
    const node = rf.getNode(pendingNodeId);
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
