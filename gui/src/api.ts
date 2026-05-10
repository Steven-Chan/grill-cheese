export type ActionKind =
  | "next"
  | "other"
  | "mark_rejected"
  | "unmark"
  | "stop"
  | "chat";

export async function postAction(
  session_id: string,
  node_id: string,
  action: ActionKind,
  branch_id?: string,
  note?: string
): Promise<void> {
  const res = await fetch("/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id, node_id, action, branch_id, note }),
  });
  if (!res.ok) throw new Error(`action ${action} failed: ${res.status}`);
}

import type { SessionMeta } from "./types";

export async function listSessions(): Promise<{ sessions: SessionMeta[] }> {
  const r = await fetch("/sessions");
  return r.json();
}

export async function getSnapshot(sid: string) {
  const r = await fetch(`/snapshot/${sid}`);
  return r.json();
}

export function exportMarkdownUrl(sid: string): string {
  return `/export/${sid}.md`;
}

export async function exportJson(sid: string): Promise<Blob> {
  const r = await fetch(`/snapshot/${sid}`);
  const text = await r.text();
  return new Blob([text], { type: "application/json" });
}
