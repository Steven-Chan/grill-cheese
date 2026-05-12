import { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import { useSession } from "../SessionContext";
import type { Branch, DecisionNode } from "../types";

// dagre layout boxes — width/height tuned so labels fit at the default
// truncation lengths below. Don't grow without re-tuning ranksep.
const DECISION_W = 240;
const DECISION_H = 72;
const SUMMARY_W = 180;
const SUMMARY_H = 56;
const IMPLICIT_W = 160;
const IMPLICIT_H = 40;
const STUB_W = 16;
const STUB_H = 16;

type EdgeKind =
  | "chosen"
  | "abandoned"
  | "chat-removed"
  | "user-authored"
  | "implicit";

interface MapNodeData extends Record<string, unknown> {
  kind: "decision" | "summary" | "implicit" | "stub";
  label: string;
  redirected?: boolean;
  pinned?: boolean;
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function classifyEdge(parent: DecisionNode, branch: Branch): EdgeKind {
  // soft-removed via chat refine — surfaces as strikethrough red
  if ((parent.removed_branch_ids ?? []).includes(branch.id)) return "chat-removed";
  if ((parent.chosen_branch_ids ?? []).includes(branch.id)) {
    // synth from Own Answer typed text — distinct from a Claude-proposed pick
    if (branch.user_authored) return "user-authored";
    return "chosen";
  }
  return "abandoned";
}

interface GraphBuild {
  nodes: FlowNode<MapNodeData>[];
  edges: Edge[];
}

function buildGraph(
  nodes: Record<string, DecisionNode>,
  order: string[],
): GraphBuild {
  // Forward link from branch → child node. Branch.child_node_id is the
  // server's authoritative pointer (server/state.py sets it in add_node);
  // the reverse-walk via parent_branch_id is a belt-and-suspenders fallback
  // for any branch where the forward pointer didn't get written (legacy
  // session JSONs, edge cases).
  const branchToChild: Record<string, string> = {};
  for (const id of order) {
    const n = nodes[id];
    if (!n || n.implicit) continue;
    if (n.parent_branch_id) branchToChild[n.parent_branch_id] = n.id;
  }

  const flowNodes: FlowNode<MapNodeData>[] = [];
  const flowEdges: Edge[] = [];

  for (const id of order) {
    const n = nodes[id];
    if (!n) continue;

    // implicit -> small leaf node hung off parent
    if (n.implicit) {
      const text = n.question || "";
      const pinned = text.startsWith("[ADR]") || text.startsWith("[CONTEXT]");
      flowNodes.push({
        id: n.id,
        type: "implicit",
        position: { x: 0, y: 0 },
        data: { kind: "implicit", label: truncate(text, 36), pinned },
      });
      if (n.parent_node_id && nodes[n.parent_node_id]) {
        flowEdges.push({
          id: `e-implicit-${n.id}`,
          source: n.parent_node_id,
          target: n.id,
          className: "gc-map-edge gc-map-edge-implicit",
        });
      }
      continue;
    }

    const isSummary = n.kind === "summary";
    flowNodes.push({
      id: n.id,
      type: isSummary ? "summary" : "decision",
      position: { x: 0, y: 0 },
      data: {
        kind: isSummary ? "summary" : "decision",
        label: truncate(isSummary ? "Verdict" : n.question, 56),
        redirected: !!n.redirected,
      },
    });

    // Summary nodes carry synthetic verdict branches (stop_here / create_plan
    // / implement_now / continue_grill) which never have children. Drawing
    // them as edges with stub terminators clutters the bottom of the map
    // without telling the reviewer anything — skip entirely.
    if (isSummary) continue;

    for (const br of n.branches) {
      const ek = classifyEdge(n, br);
      // Branch.child_node_id is the authoritative forward link (written by
      // server/state.py:add_node). Fall back to the reverse-walk only if
      // the forward pointer is unset.
      const child = br.child_node_id ?? branchToChild[br.id];
      let target = child;
      if (!target) {
        // dead-end branch -> stub terminator. Anchors the edge so it draws.
        target = `stub-${n.id}-${br.id}`;
        flowNodes.push({
          id: target,
          type: "stub",
          position: { x: 0, y: 0 },
          data: { kind: "stub", label: "" },
        });
      }
      flowEdges.push({
        id: `e-${n.id}-${br.id}`,
        source: n.id,
        target,
        label: truncate(br.label, 28),
        className: `gc-map-edge gc-map-edge-${ek}`,
        // dagre handles routing — straight lines look fine top-down
      });
    }
  }

  // dagre layout
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const fn of flowNodes) {
    const dim = dimensionsFor(fn.type as string);
    g.setNode(fn.id, { width: dim.w, height: dim.h });
  }
  for (const fe of flowEdges) {
    g.setEdge(fe.source, fe.target);
  }
  dagre.layout(g);

  for (const fn of flowNodes) {
    const pos = g.node(fn.id);
    if (!pos) continue;
    fn.position = {
      x: pos.x - pos.width / 2,
      y: pos.y - pos.height / 2,
    };
  }

  return { nodes: flowNodes, edges: flowEdges };
}

function dimensionsFor(type: string): { w: number; h: number } {
  switch (type) {
    case "implicit":
      return { w: IMPLICIT_W, h: IMPLICIT_H };
    case "stub":
      return { w: STUB_W, h: STUB_H };
    case "summary":
      return { w: SUMMARY_W, h: SUMMARY_H };
    default:
      return { w: DECISION_W, h: DECISION_H };
  }
}

// ---------- custom node renderers ----------

function DecisionMapNode({ data }: NodeProps<FlowNode<MapNodeData>>) {
  return (
    <div
      className={`gc-map-node gc-map-node-decision${
        data.redirected ? " gc-map-node-redirected" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="gc-map-handle" />
      <span className="gc-map-node-label">{data.label}</span>
      <Handle type="source" position={Position.Bottom} className="gc-map-handle" />
    </div>
  );
}

function SummaryMapNode({ data }: NodeProps<FlowNode<MapNodeData>>) {
  return (
    <div className="gc-map-node gc-map-node-summary">
      <Handle type="target" position={Position.Top} className="gc-map-handle" />
      <span className="gc-chip gc-chip-summary">{data.label}</span>
      <Handle type="source" position={Position.Bottom} className="gc-map-handle" />
    </div>
  );
}

function ImplicitMapNode({ data }: NodeProps<FlowNode<MapNodeData>>) {
  return (
    <div className="gc-map-node gc-map-node-implicit" title={data.label}>
      <Handle type="target" position={Position.Top} className="gc-map-handle" />
      <span className="gc-map-implicit-marker">{data.pinned ? "📍" : "·"}</span>
      <span className="gc-map-implicit-label">{data.label}</span>
      <Handle type="source" position={Position.Bottom} className="gc-map-handle" />
    </div>
  );
}

function StubMapNode() {
  return (
    <div className="gc-map-stub">
      <Handle type="target" position={Position.Top} className="gc-map-handle" />
    </div>
  );
}

const nodeTypes = {
  decision: DecisionMapNode,
  summary: SummaryMapNode,
  implicit: ImplicitMapNode,
  stub: StubMapNode,
};

// ---------- public component ----------

export default function DecisionMap() {
  const { state } = useSession();
  const { nodes, edges } = useMemo(
    () => buildGraph(state.nodes, state.nodeOrder),
    [state.nodes, state.nodeOrder],
  );

  // empty session guard
  if (nodes.length === 0) {
    return (
      <div className="gc-decision-map gc-decision-map-empty">
        <p className="gc-dim">No decisions yet.</p>
      </div>
    );
  }

  // ReactFlow is read-only — every interactive prop locked off.
  // Pan + zoom are the only allowed inputs. No click handlers. See ADR-0002.
  // Wrapping in ReactFlowProvider is defensive — MiniMap/Controls use the
  // xyflow internal store and the explicit provider survives any future
  // refactor that moves them outside the ReactFlow children tree.
  return (
    <div className="gc-decision-map">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          nodesFocusable={false}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          maxZoom={1.5}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
          {nodes.length > 30 && (
            <MiniMap pannable={false} zoomable={false} ariaLabel="map overview" />
          )}
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
