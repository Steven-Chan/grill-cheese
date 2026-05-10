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
import type { DecisionNode as DNode } from "../types";

const nodeTypes = { decision: DecisionNodeView };

export function Canvas() {
  const nodes = useStore((s) => s.nodes);
  const pendingNodeId = useStore((s) => s.pendingNodeId);
  const lastPendingNodeId = useStore((s) => s.lastPendingNodeId);
  const frontierOnly = useStore((s) => s.frontierOnly);

  const { rfNodes, rfEdges } = useMemo(() => {
    const anchor = pendingNodeId ?? lastPendingNodeId;
    const visible = filterVisible(nodes, frontierOnly, anchor);
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
  }, [nodes, pendingNodeId, lastPendingNodeId, frontierOnly]);

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

function filterVisible(
  nodes: Record<string, DNode>,
  frontierOnly: boolean,
  anchorNodeId: string | null
): DNode[] {
  const all = Object.values(nodes);
  if (!frontierOnly) return all;
  // frontier = anchor + its ancestors + immediate children + implicit decisions.
  // anchor = pendingNodeId if a node awaits, else lastPendingNodeId (last-touched).
  if (!anchorNodeId) return all;
  const keep = new Set<string>();
  // ancestor chain
  let cursor: string | null = anchorNodeId;
  while (cursor) {
    keep.add(cursor);
    const n: DNode | undefined = nodes[cursor];
    cursor = n?.parent_node_id ?? null;
  }
  // children of pending (none yet typically; but include for stability)
  for (const n of all) {
    if (n.parent_node_id && keep.has(n.parent_node_id)) keep.add(n.id);
  }
  // implicit decisions always shown
  for (const n of all) if (n.implicit) keep.add(n.id);
  return all.filter((n) => keep.has(n.id));
}
