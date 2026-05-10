import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";

export const NODE_W = 360;
export const NODE_H = 220;
export const SUMMARY_W = 480;
// First-paint fallback before xyflow measures real DOM. Canvas feeds
// measured dims into nodeSizes once available, so this only matters for
// the first frame after a node mounts.
export const SUMMARY_H = 620;

export interface NodeSize {
  w: number;
  h: number;
}

export function layoutTree(
  nodes: Node[],
  edges: Edge[],
  nodeSizes?: Record<string, NodeSize>,
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 140, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    const sz = nodeSizes?.[n.id] ?? { w: NODE_W, h: NODE_H };
    g.setNode(n.id, { width: sz.w, height: sz.h });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  const positioned = nodes.map((n) => {
    const p = g.node(n.id);
    const sz = nodeSizes?.[n.id] ?? { w: NODE_W, h: NODE_H };
    return {
      ...n,
      position: { x: (p?.x ?? 0) - sz.w / 2, y: (p?.y ?? 0) - sz.h / 2 },
    };
  });
  return { nodes: positioned, edges };
}
