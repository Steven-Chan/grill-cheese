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
    rf.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
      duration: FOCUS_DURATION_MS,
      zoom: rf.getZoom(),
    });
  }, [pendingNodeId, nodesInitialized, rf]);

  const jumpToPending = () => {
    if (!pendingNodeId) return;
    const node = rf.getNode(pendingNodeId);
    if (!node) return;
    const w = node.measured?.width ?? NODE_W;
    const h = node.measured?.height ?? NODE_H;
    setUserPanned(false);
    rf.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
      duration: FOCUS_DURATION_MS,
      zoom: rf.getZoom(),
    });
  };

  // onMoveStart fires only on user-initiated pan/zoom (not programmatic setCenter).
  const handleMoveStart = () => setUserPanned(true);

  const showJump = pendingNodeId !== null && userPanned;

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
          <button className="gc-jump-btn" onClick={jumpToPending}>
            ↩ jump to new question
          </button>
        </Panel>
      )}
    </ReactFlow>
  );
}
