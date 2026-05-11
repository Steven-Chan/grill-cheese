import type { SessionMeta } from "./types";

export type ActionKind =
  | "next"
  | "stop"
  | "chat"
  | "stop_here"
  | "create_plan"
  | "implement_now"
  | "continue_grill";

export interface ActionOpts {
  // plural pick set for action=next (radio = length 1, multi = ≥1)
  branch_ids?: string[];
  // single-id scope for action=chat (chat-on-row)
  branch_id?: string;
  // typed text — server synthesizes a user_authored Branch on next
  note?: string;
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
