export interface Branch {
  id: string;
  label: string;
  rationale: string;
  is_recommended: boolean;
  // synth from a typed-text submit (next + own_answer). Tagged in GUI.
  user_authored?: boolean;
  child_node_id: string | null;
}

export type NodeKind = "decision" | "summary";
// `resolve` removed — see docs/adr/0001-non-blocking-chat.md.
export type ChatOutcome = "refine" | "redirect";

export interface ChatBlock {
  chat_id: string;
  summary: string;
  outcome: ChatOutcome;
  applied_at: number;
}

// inline-chat: live transcript msg, role = user | assistant.
export interface ChatMessage {
  msg_id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
}

// inline-chat: a staged proposal from Claude. Multiple may be staged at
// once (Claude offers alternatives); user picks ONE via proposal_id.
export interface PendingProposal {
  proposal_id: string;
  chat_id: string;
  outcome: ChatOutcome;
  ops?: { adds?: Branch[]; removes?: string[] } | null;
  summary: string;
  proposed_at: number;
}

// Composer-side primitive — a reference to a branch dragged/clicked into
// the chat composer. Serializes inline in the wire message as
// `[Branch <id>: <label>]`; the server stores the message verbatim and
// Claude parses chips on read. Client-side state only — never on the wire.
export interface ChipRef {
  branch_id: string;
  label: string;
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
  // render mode: false = radio (single pick), true = checkboxes + Submit
  multi_select?: boolean;
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
  // doc-awareness flag, summary-only. When true: implement_now is hidden in
  // GUI + rejected server-side (must plan docs first). create_plan /
  // stop_here / continue_grill remain valid.
  generate_docs?: boolean;
  // short reason Claude provides alongside generate_docs=true. Includes the
  // 3-criteria ADR checklist when ADR-worthy. Rendered as a caption on the
  // summary card.
  docs_reason?: string | null;
  // plural-only chosen state (radio = list of length 1).
  chosen_branch_ids?: string[];
  // chat-removed branch ids; soft delete, branch entry stays in branches[]
  removed_branch_ids?: string[];
  // accumulating chat outcomes applied to this node
  chats?: ChatBlock[];
  // true when chat outcome == "redirect" — node abandoned, greyed out
  redirected?: boolean;
  // inline-chat: live transcript. Composer is always-visible; empty list
  // = no chat thread started yet on this node.
  chat_messages?: ChatMessage[];
  // inline-chat: staged proposals from Claude. Multi-slot — N alternatives
  // user picks one of. Empty list when no proposals are staged. Whole list
  // replaced atomically on a fresh stage (no stacking).
  pending_proposals?: PendingProposal[];
  // server-internal action buffer fields (persistence). GUI ignores.
  pending_actions?: unknown[];
  committed_actions?: unknown[];
  is_flushed?: boolean;
  // pick-rate score in [0, 1] or null. Set on the next-commit flush.
  // null for summary, implicit, and multi-mode with zero recommendations.
  // See CONTEXT.md "Recommendation score" + ADR-0003.
  recommendation_score?: number | null;
  // honest progress fraction in [0,1] emitted by Claude on each push.
  // null = indeterminate barber-pole stripe. Summary nodes pin to 1.0
  // server-side. Downward changes are honest (no monotonic clamp).
  // See ADR-0007.
  progress?: number | null;
  // reconsider mark (🚩) state. "marked" = user just clicked, Claude not
  // yet woken; "seen" = shim delivered the channel notif, Claude has it.
  // Cleared back to "unmarked" when Claude pushes the reconsider-fork
  // node N'. See ADR-0009.
  reconsider_marked?: "unmarked" | "marked" | "seen";
}

export interface HookTrace {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  timestamp: number;
  grill_node_id?: string | null;
}

// `paused` removed — non-blocking chat (ADR-0001).
export type SessionStatus = "active" | "ended";

// Deep-link coords for the cmux pane hosting this CC session. All fields
// optional — workspace_id is the only one required to make any jump useful.
export interface CmuxInfo {
  workspace_id?: string | null;
  panel_id?: string | null;
  socket_path?: string | null;
  bin_path?: string | null;
}

export type SessionKind = "retro";

export interface SessionMeta {
  id: string;
  title: string | null;
  brief: string;
  project?: string;
  started_at: number;
  status: SessionStatus;
  has_pending: boolean;
  // null/undefined for regular grills; "retro" for retrospective sessions
  // (ADR-0005). Retros self-exclude from future retros' windows.
  kind?: SessionKind | null;
  // Per-session pick rate enriched from performance.jsonl (ADR-0003).
  // score/decision_count/verdict are null when no perf entry exists for
  // this session (pre-feature, still active, or never ended). When the
  // entry exists, decision_count is always an integer (0 if no scored
  // decisions); score may still be null (no scored decisions case).
  score?: number | null;
  decision_count?: number | null;
  verdict?: string | null;
}

// One performance.jsonl entry. Returned flat from /api/performance, newest
// first; GUI groups by date. See ADR-0003.
export type PerfVerdict = "stop_here" | "create_plan" | "implement_now" | "end_session";

export interface PerformanceEntry {
  session_id: string;
  project: string;
  title: string | null;
  ended_at: number;
  score: number | null;
  decision_count: number;
  verdict: PerfVerdict;
  // null/undefined for regular grills; "retro" tags retrospective sessions
  // (ADR-0005). GUI uses this to render a distinct chip and exclude retros
  // from pick-rate aggregates.
  kind?: SessionKind | null;
}

// Speculation (ADR-0010) — wire types
export interface ParkedSlotHint {
  slot_id: string;
  question_oneline: string;
}

export type SseEvent =
  | { type: "hello"; session_id: string; payload: Record<string, unknown> }
  | { type: "ping"; session_id: string; payload: Record<string, unknown> }
  | { type: "session_started"; session_id: string; payload: { title: string | null; brief: string; started_at: number } }
  | { type: "session_meta"; session_id: string; payload: { cmux?: CmuxInfo | null } }
  | { type: "session_list"; session_id: ""; payload: { sessions: SessionMeta[] } }
  | { type: "session_ended"; session_id: string; payload: { summary: string; ended_at: number } }
  | { type: "session_deleted"; session_id: string; payload: { project: string } }
  | { type: "session_wrap"; session_id: string; payload: Record<string, unknown> }
  | { type: "node_added"; session_id: string; payload: DecisionNode }
  | { type: "node_updated"; session_id: string; payload: DecisionNode }
  | { type: "node_committed"; session_id: string; payload: { node_id: string; seq: number; actions: Array<{ node_id: string; chosen_branch_ids?: string[] | null; chosen_branch_labels?: string[] | null; own_answer?: string | null; action: string }>; generate_docs?: boolean; docs_reason?: string | null; pending_reconsiders?: string[]; parked_slots?: ParkedSlotHint[] } }
  | { type: "parked_queue_updated"; session_id: string; payload: { parked_slots: ParkedSlotHint[] } }
  | { type: "chat_message_added"; session_id: string; payload: { node_id: string; chat_id: string; message: ChatMessage; seq?: number } }
  | { type: "chat_proposals_staged"; session_id: string; payload: { node_id: string; proposals: PendingProposal[] } }
  | { type: "chat_accepted"; session_id: string; payload: { node_id: string; chat_id: string; outcome: ChatOutcome | null; redirect_branch_id?: string | null } }
  | { type: "chat_closed"; session_id: string; payload: { node_id: string; chat_id: string } }
  | { type: "node_reconsider_marked"; session_id: string; payload: { node_id: string; reconsider_marked: "unmarked" | "marked" | "seen"; reconsider_queue: string[] } }
  | { type: "hook_event"; session_id: string; payload: HookTrace & { grill_node_id?: string | null; grill_session_id?: string | null } };
