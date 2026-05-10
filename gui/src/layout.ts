import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";

export const NODE_W = 360;
export const NODE_H = 220;

export function layoutTree(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 100, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  const positioned = nodes.map((n) => {
    const p = g.node(n.id);
    return {
      ...n,
      position: { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 },
    };
  });
  return { nodes: positioned, edges };
}
