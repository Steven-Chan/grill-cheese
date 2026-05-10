import { useMemo } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useStore } from "../store";
import { layoutTree } from "../layout";
import { DecisionNode as DecisionNodeView } from "./DecisionNode";

const nodeTypes = { decision: DecisionNodeView };

export function Canvas() {
  const nodes = useStore((s) => s.nodes);
  const pendingNodeId = useStore((s) => s.pendingNodeId);

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

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      fitView
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: "smoothstep" }}
    >
      <Background gap={32} size={1} color="var(--gc-grid)" />
      <Controls />
    </ReactFlow>
  );
}
