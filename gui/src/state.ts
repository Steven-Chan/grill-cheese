import type { CmuxInfo, DecisionNode, PausedState, SessionMeta, SessionStatus } from "./types";

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
  // toolbar Wrap-up fired; awaiting skill's present_summary push. Cleared
  // on session_ended / continue_grill / fresh session_started.
  wrapping: boolean;
  // null when CC wasn't launched inside cmux. Enables "Jump to terminal".
  cmux: CmuxInfo | null;
}

export type SessionAction =
  | { type: "hydrate"; snapshot: Snapshot }
  | { type: "session_started"; title: string | null; brief: string; project?: string; startedAt: number }
  | { type: "session_meta"; cmux?: CmuxInfo | null }
  | { type: "session_ended"; summary: string }
  | { type: "session_paused"; paused: PausedState }
  | { type: "session_resumed" }
  | { type: "session_wrap" }
  | { type: "node_added"; node: DecisionNode }
  | { type: "node_updated"; node: DecisionNode }
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
  // null when not wrapping; "__wrap_pending__" sentinel between wrap click
  // and the skill's first present_summary; real node id thereafter.
  wrap_summary_node_id: string | null;
  nodes: Record<string, DecisionNode>;
  // server returns root_node_id + nodes; we derive order via BFS from root + insertion fallback
  root_node_id: string | null;
  cmux?: CmuxInfo | null;
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
    wrapping: false,
    cmux: null,
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

// Server schema has `is_flushed` but not `committed`. Without this mirror, a
// node_updated broadcast (parent update, post-apply mutation) overwrites a
// previously-committed node with `committed=undefined`, breaking findPending
// + BigCard fallback (the wiped node looks pending again).
function mirrorCommitted(
  incoming: DecisionNode,
  existing?: DecisionNode,
): DecisionNode {
  const flushed = !!incoming.is_flushed;
  return {
    ...incoming,
    committed: flushed,
    // committed_action only arrives on node_committed, never on node_updated.
    // Preserve it while still flushed; clear on unlock (chat-refine path
    // resets is_flushed=false server-side).
    committed_action: flushed
      ? existing?.committed_action ?? incoming.committed_action ?? null
      : null,
  };
}

// Pending = last decision/summary node that isn't committed, isn't redirected,
// isn't implicit (silent record-only), and hasn't already had a pick land.
// chosen_branch_ids.length>0 catches chat-resolve (server synthesises a chosen
// branch and unlocks the node, so `committed` doesn't flip in our state).
function findPending(state: Pick<SessionState, "nodes" | "nodeOrder">): string | null {
  for (let i = state.nodeOrder.length - 1; i >= 0; i--) {
    const n = state.nodes[state.nodeOrder[i]];
    if (!n) continue;
    if (n.redirected) continue;
    if (n.implicit) continue;
    if (n.committed) continue;
    if ((n.chosen_branch_ids ?? []).length > 0) continue;
    return n.id;
  }
  return null;
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "hydrate": {
      const snap = action.snapshot;
      const order = orderNodes(snap.nodes);
      const nodes: Record<string, DecisionNode> = {};
      for (const [id, n] of Object.entries(snap.nodes)) {
        nodes[id] = mirrorCommitted(n);
      }
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
        nodes,
        nodeOrder: order,
        wrapping: snap.wrap_summary_node_id != null,
        cmux: snap.cmux ?? null,
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
    case "session_meta":
      return { ...state, cmux: action.cmux ?? state.cmux };
    case "session_ended":
      return { ...state, endedSummary: action.summary, status: "ended", pendingNodeId: null, paused: null, wrapping: false };
    case "session_paused":
      return { ...state, status: "paused", paused: action.paused };
    case "session_resumed":
      return { ...state, status: "active", paused: null };
    case "session_wrap":
      return { ...state, wrapping: true };
    case "node_added": {
      const merged = mirrorCommitted(action.node, state.nodes[action.node.id]);
      const nodes = { ...state.nodes, [action.node.id]: merged };
      const nodeOrder = state.nodeOrder.includes(action.node.id)
        ? state.nodeOrder
        : [...state.nodeOrder, action.node.id];
      const next = { ...state, nodes, nodeOrder };
      next.pendingNodeId = findPending(next);
      return next;
    }
    case "node_updated": {
      const merged = mirrorCommitted(action.node, state.nodes[action.node.id]);
      const nodes = { ...state.nodes, [action.node.id]: merged };
      const next = { ...state, nodes };
      next.pendingNodeId = findPending(next);
      return next;
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
      // continue_grill verdict un-wraps the session (server clears
      // wrap_summary_node_id). Mirror that flip locally so the toolbar
      // button + any wrap-conditional UI returns to its idle state.
      const wrapping = action.action === "continue_grill" ? false : state.wrapping;
      const next = { ...state, nodes, wrapping };
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
