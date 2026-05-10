import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";

export const NODE_W = 360;
export const NODE_H = 220;
export const SUMMARY_W = 480;
// dagre needs a fixed estimate; summary body is auto-height in DOM. Bumped
// to 720 so that even multi-paragraph markdown + 4 buttons + textarea (often
// 540–620px actual) doesn't overlap children. Very long bodies may still
// overlap — that's a dagre limitation, mitigate by tightening summary text.
export const SUMMARY_H = 720;

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
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 100, marginx: 40, marginy: 40 });
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
