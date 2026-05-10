export interface Branch {
  id: string;
  label: string;
  rationale: string;
  is_recommended: boolean;
  child_node_id: string | null;
}

export type NodeKind = "decision" | "summary";
export type ChatOutcome = "refine" | "redirect" | "resolve";

export interface ChatBlock {
  chat_id: string;
  summary: string;
  outcome: ChatOutcome;
  applied_at: number;
  branch_id?: string | null;
}

export interface DecisionNode {
  id: string;
  parent_node_id: string | null;
  parent_branch_id: string | null;
  question: string;
  reasoning: string;
  branches: Branch[];
  depth: number;
  implicit: boolean;
  created_at: number;
  user_note: string | null;
  // set true after server flushes the click buffer — node locked, no more input
  committed?: boolean;
  // last terminal action committed (e.g. "stop_here", "create_plan"). Set
  // alongside committed=true. Used by SummaryNode to highlight which verdict
  // the user picked.
  committed_action?: string | null;
  // null/undefined = "decision"; "summary" = verdict card
  kind?: NodeKind | null;
  // markdown body, populated only when kind === "summary"
  summary_body?: string | null;
  // single source of truth for the picked branch (replaces Branch.state)
  chosen_branch_id?: string | null;
  // chat-removed branch ids; soft delete, branch entry stays in branches[]
  removed_branch_ids?: string[];
  // accumulating chat outcomes applied to this node
  chats?: ChatBlock[];
  // true when chat outcome == "redirect" — node abandoned, greyed out
  redirected?: boolean;
  // server-internal action buffer fields (persistence). GUI ignores.
  pending_actions?: unknown[];
  committed_actions?: unknown[];
  is_flushed?: boolean;
}

export interface HookTrace {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  timestamp: number;
  grill_node_id?: string | null;
  // server-tagged when hook arrived during a chat session-paused state
  chat_tag?: boolean;
}

export type SessionStatus = "active" | "paused" | "ended";

export interface SessionMeta {
  id: string;
  brief: string;
  started_at: number;
  status: SessionStatus;
  has_pending: boolean;
}

export interface PausedState {
  node_id: string;
  branch_id: string | null;
}

export type SseEvent =
  | { type: "hello"; session_id: string; payload: Record<string, unknown> }
  | { type: "ping"; session_id: string; payload: Record<string, unknown> }
  | { type: "session_started"; session_id: string; payload: { brief: string; started_at: number } }
  | { type: "session_list"; session_id: ""; payload: { sessions: SessionMeta[] } }
  | { type: "session_ended"; session_id: string; payload: { summary: string; ended_at: number } }
  | { type: "session_paused"; session_id: string; payload: { node_id: string; branch_id: string | null } }
  | { type: "session_resumed"; session_id: string; payload: Record<string, unknown> }
  | { type: "node_added"; session_id: string; payload: DecisionNode }
  | { type: "node_updated"; session_id: string; payload: DecisionNode }
  | { type: "node_resolved"; session_id: string; payload: { node_id: string; chosen_branch_id?: string; chosen_branch_label?: string; note?: string; action: string } }
  | { type: "node_committed"; session_id: string; payload: { node_id: string; actions: Array<{ node_id: string; chosen_branch_id?: string | null; chosen_branch_label?: string | null; note?: string | null; action: string }> } }
  | { type: "hook_event"; session_id: string; payload: HookTrace & { grill_node_id?: string | null; grill_session_id?: string | null } };
