import type { SseEvent } from "./types";

// Open a per-session SSE stream. `sessionId === null` → global stream
// (carries session_list, session_started, session_deleted).
// Returns a cleanup function — caller (useEffect) must call it on unmount.
export function openSse(sessionId: string | null, onEvent: (ev: SseEvent) => void): () => void {
  const url = sessionId ? `/events?session=${sessionId}` : "/events";
  const es = new EventSource(url);

  const handle = (raw: string) => {
    if (!raw) return;
    let parsed: SseEvent;
    try {
      parsed = JSON.parse(raw) as SseEvent;
    } catch {
      return;
    }
    onEvent(parsed);
  };

  es.onmessage = (e) => handle(e.data);
  const types = [
    "hello",
    "ping",
    "session_started",
    "session_list",
    "session_ended",
    "session_deleted",
    "session_paused",
    "session_resumed",
    "node_added",
    "node_updated",
    "node_resolved",
    "node_committed",
    "hook_event",
  ];
  for (const t of types) {
    es.addEventListener(t, (e: MessageEvent) => handle(e.data));
  }
  es.onerror = () => {
    // browser auto-reconnects EventSource; no-op
  };

  return () => {
    es.close();
  };
}
