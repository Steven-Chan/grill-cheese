import { create } from "zustand";
import type { DecisionNode, HookTrace, PausedState, SessionMeta } from "./types";

interface State {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  brief: string;
  nodes: Record<string, DecisionNode>;
  hookTraces: Record<string, HookTrace[]>; // node_id -> traces
  pendingNodeId: string | null; // node currently awaiting user action
  lastPendingNodeId: string | null; // last node we saw pending (for frontier anchor)
  endedSummary: string | null;
  paused: PausedState | null; // chat-handoff: session paused, user in CC
  frontierOnly: boolean;

  setActive(sid: string): void;
  setBrief(b: string): void;
  addNode(n: DecisionNode): void;
  updateNode(n: DecisionNode): void;
  setNodeResolved(node_id: string): void;
  appendHook(trace: HookTrace): void;
  setSessions(s: SessionMeta[]): void;
  reset(): void;
  setEnded(summary: string): void;
  setPaused(p: PausedState): void;
  setResumed(): void;
  toggleFrontier(): void;
}

export const useStore = create<State>((set) => ({
  sessions: [],
  activeSessionId: null,
  brief: "",
  nodes: {},
  hookTraces: {},
  pendingNodeId: null,
  lastPendingNodeId: null,
  endedSummary: null,
  paused: null,
  frontierOnly: true,

  setActive: (sid) =>
    set(() => ({
      activeSessionId: sid,
      nodes: {},
      hookTraces: {},
      pendingNodeId: null,
      lastPendingNodeId: null,
      endedSummary: null,
      paused: null,
    })),
  setBrief: (b) => set(() => ({ brief: b })),
  addNode: (n) =>
    set((s) => ({
      nodes: { ...s.nodes, [n.id]: n },
      pendingNodeId: n.id,
      lastPendingNodeId: n.id,
    })),
  updateNode: (n) =>
    set((s) => ({
      nodes: { ...s.nodes, [n.id]: n },
    })),
  setNodeResolved: (node_id) =>
    set((s) => ({
      pendingNodeId: s.pendingNodeId === node_id ? null : s.pendingNodeId,
      // keep lastPendingNodeId pinned to most-recent so frontier filter has anchor
      lastPendingNodeId: s.pendingNodeId === node_id ? node_id : s.lastPendingNodeId,
    })),
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
      lastPendingNodeId: null,
      endedSummary: null,
      paused: null,
    })),
  setEnded: (summary) => set(() => ({ endedSummary: summary, pendingNodeId: null, paused: null })),
  // pause clears pending so branch buttons go inert while user is back in CC
  setPaused: (p) => set(() => ({ paused: p, pendingNodeId: null })),
  setResumed: () => set(() => ({ paused: null })),
  toggleFrontier: () => set((s) => ({ frontierOnly: !s.frontierOnly })),
}));
