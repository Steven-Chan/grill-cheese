import type { SessionMeta } from "./types";

export type ActionKind =
  | "next"
  | "chat"
  | "stop_here"
  | "create_plan"
  | "implement_now"
  | "continue_grill"
  | "chat_user_msg"
  | "chat_accept"
  | "chat_close";

export interface ActionOpts {
  // plural pick set for action=next (radio = length 1, multi = ≥1)
  branch_ids?: string[];
  // single-id scope for action=chat (chat-on-row)
  branch_id?: string;
  // typed text — server synthesizes a user_authored Branch on next
  note?: string;
  // inline-chat: thread id (client-generated, stable for the chat lifetime)
  chat_id?: string;
  // inline-chat: per-message uuid (action=chat_user_msg)
  msg_id?: string;
  // inline-chat: typed message text (action=chat_user_msg)
  text?: string;
  // inline-chat: which staged proposal user picked (action=chat_accept)
  proposal_id?: string;
}

export interface ActionRejection {
  status: number;
  err?: string;
}

// Throws ActionRejection on 4xx (caller maps to UX); throws Error on other failures.
export async function postAction(
  session_id: string,
  node_id: string,
  action: ActionKind,
  opts?: ActionOpts
): Promise<void> {
  const body = {
    session_id,
    node_id,
    action,
    branch_ids: opts?.branch_ids ?? [],
    branch_id: opts?.branch_id,
    note: opts?.note,
    chat_id: opts?.chat_id,
    msg_id: opts?.msg_id,
    text: opts?.text,
    proposal_id: opts?.proposal_id,
  };
  const res = await fetch("/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 409 || (res.status >= 400 && res.status < 500)) {
    let payload: { err?: string } = {};
    try {
      payload = await res.json();
    } catch {
      // ignore parse failure
    }
    const rej: ActionRejection = { status: res.status, err: payload.err };
    throw rej;
  }
  if (!res.ok) throw new Error(`action ${action} failed: ${res.status}`);
}

export async function listSessions(): Promise<{ sessions: SessionMeta[] }> {
  const r = await fetch("/api/sessions");
  return r.json();
}

export async function getSnapshot(sid: string) {
  const r = await fetch(`/api/snapshot/${sid}`);
  if (!r.ok) throw new Error(`snapshot ${sid} failed: ${r.status}`);
  return r.json();
}

export function exportMarkdownUrl(sid: string): string {
  return `/export/${sid}.md`;
}

export async function deleteSession(sid: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sid}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`delete failed: ${res.status}`);
  }
}

// Focus the cmux pane that hosts this CC session. Server shells the cmux
// CLI; 409 when the session has no cmux coords (CC wasn't launched inside
// cmux); 502 when the CLI itself fails.
export async function postJumpToCmux(session_id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${session_id}/jump-to-cmux`, {
    method: "POST",
  });
  if (res.status >= 400 && res.status < 500) {
    let payload: { err?: string } = {};
    try {
      payload = await res.json();
    } catch {
      // ignore
    }
    const rej: ActionRejection = { status: res.status, err: payload.err };
    throw rej;
  }
  if (!res.ok) throw new Error(`jump-to-cmux failed: ${res.status}`);
}


// Toolbar Wrap-up signal. Session-level: no node bound. Server emits
// session_wrap SSE; skill responds with present_summary. Throws
// ActionRejection on 4xx for consistent toast handling.
export async function postWrap(session_id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${session_id}/wrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (res.status >= 400 && res.status < 500) {
    let payload: { err?: string } = {};
    try {
      payload = await res.json();
    } catch {
      // ignore parse failure
    }
    const rej: ActionRejection = { status: res.status, err: payload.err };
    throw rej;
  }
  if (!res.ok) throw new Error(`wrap failed: ${res.status}`);
}
