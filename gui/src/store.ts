import { create } from "zustand";
import type { DecisionNode, HookTrace, PausedState, SessionMeta } from "./types";

interface State {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  brief: string;
  nodes: Record<string, DecisionNode>;
  hookTraces: Record<string, HookTrace[]>; // node_id -> traces
  pendingNodeId: string | null; // node currently awaiting user action
  endedSummary: string | null;
  paused: PausedState | null; // chat-handoff: session paused, user in CC
  userPanned: boolean; // user manually moved viewport since last new node

  setActive(sid: string): void;
  setBrief(b: string): void;
  addNode(n: DecisionNode): void;
  updateNode(n: DecisionNode): void;
  setNodeResolved(node_id: string): void;
  setNodeCommitted(node_id: string, action?: string | null): void;
  appendHook(trace: HookTrace): void;
  setSessions(s: SessionMeta[]): void;
  reset(): void;
  setEnded(summary: string): void;
  setPaused(p: PausedState): void;
  setResumed(): void;
  setUserPanned(v: boolean): void;
}

export const useStore = create<State>((set) => ({
  sessions: [],
  activeSessionId: null,
  brief: "",
  nodes: {},
  hookTraces: {},
  pendingNodeId: null,
  endedSummary: null,
  paused: null,
  userPanned: false,

  setActive: (sid) =>
    set(() => ({
      activeSessionId: sid,
      nodes: {},
      hookTraces: {},
      pendingNodeId: null,
      endedSummary: null,
      paused: null,
      userPanned: false,
    })),
  setBrief: (b) => set(() => ({ brief: b })),
  addNode: (n) =>
    set((s) => ({
      nodes: { ...s.nodes, [n.id]: n },
      pendingNodeId: n.id,
      userPanned: false, // new node arrived → fresh chance to auto-focus
    })),
  updateNode: (n) =>
    set((s) => ({
      nodes: { ...s.nodes, [n.id]: n },
    })),
  setNodeResolved: (node_id) =>
    set((s) => ({
      pendingNodeId: s.pendingNodeId === node_id ? null : s.pendingNodeId,
    })),
  setNodeCommitted: (node_id, action) =>
    set((s) => {
      const n = s.nodes[node_id];
      if (!n) return {};
      return {
        nodes: {
          ...s.nodes,
          [node_id]: { ...n, committed: true, committed_action: action ?? n.committed_action ?? null },
        },
        pendingNodeId: s.pendingNodeId === node_id ? null : s.pendingNodeId,
      };
    }),
  appendHook: (trace) =>
    set((s) => {
      const key = trace.grill_node_id || "_unbound";
      const list = s.hookTraces[key] || [];
      return { hookTraces: { ...s.hookTraces, [key]: [...list, trace] } };
    }),
  setSessions: (sessions) => set(() => ({ sessions })),
  reset: () =>
    set(() => ({
      activeSessionId: null,
      brief: "",
      nodes: {},
      hookTraces: {},
      pendingNodeId: null,
      endedSummary: null,
      paused: null,
      userPanned: false,
    })),
  setEnded: (summary) => set(() => ({ endedSummary: summary, pendingNodeId: null, paused: null })),
  // pause is a session-status flip; node stays pending so its buttons remain
  // active. User can pick / type other / chat-again while paused.
  setPaused: (p) =>
    set((s) => ({
      paused: p,
      // restore pending to the paused node if it was lost (e.g., SSE replay
      // after refresh) — buttons must always be live on the paused node.
      pendingNodeId: s.pendingNodeId ?? p.node_id,
    })),
  setResumed: () => set(() => ({ paused: null })),
  setUserPanned: (v) => set(() => ({ userPanned: v })),
}));
