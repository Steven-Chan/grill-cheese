import type { DecisionNode, PausedState, SessionMeta, SessionStatus } from "./types";

// Per-session reducer state. List state lives separately (useReducer in list page).
export interface SessionState {
  sid: string;
  loaded: boolean; // true after snapshot hydration completes
  title: string | null;
  brief: string;
  project: string | null;
  startedAt: number;
  status: SessionStatus;
  paused: PausedState | null;
  endedSummary: string | null;
  // node_id -> node
  nodes: Record<string, DecisionNode>;
  // insertion order — drives linear feed render
  nodeOrder: string[];
  pendingNodeId: string | null;
}

export type SessionAction =
  | { type: "hydrate"; snapshot: Snapshot }
  | { type: "session_started"; title: string | null; brief: string; project?: string; startedAt: number }
  | { type: "session_ended"; summary: string }
  | { type: "session_paused"; paused: PausedState }
  | { type: "session_resumed" }
  | { type: "node_added"; node: DecisionNode }
  | { type: "node_updated"; node: DecisionNode }
  | { type: "node_resolved"; node_id: string }
  | { type: "node_committed"; node_id: string; action: string | null };

export interface Snapshot {
  id: string;
  title: string | null;
  brief: string;
  project?: string;
  started_at: number;
  status: SessionStatus;
  paused_node_id: string | null;
  paused_branch_id: string | null;
  nodes: Record<string, DecisionNode>;
  // server returns root_node_id + nodes; we derive order via BFS from root + insertion fallback
  root_node_id: string | null;
}

export function initialSessionState(sid: string): SessionState {
  return {
    sid,
    loaded: false,
    title: null,
    brief: "",
    project: null,
    startedAt: 0,
    status: "active",
    paused: null,
    endedSummary: null,
    nodes: {},
    nodeOrder: [],
    pendingNodeId: null,
  };
}

// Linearise the tree by creation order. Server gives us a dict + a root id;
// we sort by created_at since insertion order matches grilling order.
function orderNodes(nodes: Record<string, DecisionNode>): string[] {
  return Object.values(nodes)
    .slice()
    .sort((a, b) => a.created_at - b.created_at)
    .map((n) => n.id);
}

// Pending = last decision/summary node that isn't committed and isn't redirected.
function findPending(state: Pick<SessionState, "nodes" | "nodeOrder">): string | null {
  for (let i = state.nodeOrder.length - 1; i >= 0; i--) {
    const n = state.nodes[state.nodeOrder[i]];
    if (!n) continue;
    if (n.redirected) continue;
    if (n.committed) continue;
    return n.id;
  }
  return null;
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "hydrate": {
      const snap = action.snapshot;
      const order = orderNodes(snap.nodes);
      const next: SessionState = {
        ...state,
        loaded: true,
        title: snap.title,
        brief: snap.brief,
        project: snap.project ?? null,
        startedAt: snap.started_at,
        status: snap.status,
        paused: snap.paused_node_id
          ? { node_id: snap.paused_node_id, branch_id: snap.paused_branch_id }
          : null,
        nodes: { ...snap.nodes },
        nodeOrder: order,
      };
      next.pendingNodeId = findPending(next);
      return next;
    }
    case "session_started":
      return {
        ...state,
        loaded: true,
        title: action.title,
        brief: action.brief,
        project: action.project ?? state.project,
        startedAt: action.startedAt,
        status: "active",
      };
    case "session_ended":
      return { ...state, endedSummary: action.summary, status: "ended", pendingNodeId: null, paused: null };
    case "session_paused":
      return { ...state, status: "paused", paused: action.paused };
    case "session_resumed":
      return { ...state, status: "active", paused: null };
    case "node_added": {
      const nodes = { ...state.nodes, [action.node.id]: action.node };
      const nodeOrder = state.nodeOrder.includes(action.node.id)
        ? state.nodeOrder
        : [...state.nodeOrder, action.node.id];
      const next = { ...state, nodes, nodeOrder };
      next.pendingNodeId = findPending(next);
      return next;
    }
    case "node_updated": {
      const nodes = { ...state.nodes, [action.node.id]: action.node };
      const next = { ...state, nodes };
      next.pendingNodeId = findPending(next);
      return next;
    }
    case "node_resolved": {
      // server-side resolution (e.g. chat outcome). pendingNodeId recomputed.
      return { ...state, pendingNodeId: findPending(state) };
    }
    case "node_committed": {
      const n = state.nodes[action.node_id];
      if (!n) return state;
      const updated: DecisionNode = {
        ...n,
        committed: true,
        committed_action: action.action ?? n.committed_action ?? null,
      };
      const nodes = { ...state.nodes, [action.node_id]: updated };
      const next = { ...state, nodes };
      next.pendingNodeId = findPending(next);
      return next;
    }
    default:
      return state;
  }
}

// ---------- list state ----------

export interface ListState {
  sessions: SessionMeta[];
  loaded: boolean;
}

export type ListAction =
  | { type: "set_sessions"; sessions: SessionMeta[] }
  | { type: "session_deleted"; id: string };

export const initialListState: ListState = { sessions: [], loaded: false };

export function listReducer(state: ListState, action: ListAction): ListState {
  switch (action.type) {
    case "set_sessions":
      return { sessions: action.sessions, loaded: true };
    case "session_deleted":
      return { ...state, sessions: state.sessions.filter((s) => s.id !== action.id) };
    default:
      return state;
  }
}
