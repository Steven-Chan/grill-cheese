import { useStore } from "./store";
import type { HookTrace, SseEvent } from "./types";

let es: EventSource | null = null;
let currentSid: string | null | undefined = undefined;

export function connectSse(sessionId: string | null) {
  if (es && currentSid === sessionId) return;
  if (es) {
    es.close();
    es = null;
  }
  currentSid = sessionId;
  const url = sessionId ? `/events?session=${sessionId}` : "/events";
  es = new EventSource(url);
  es.onmessage = (e) => handle(e.data);
  // sse-starlette emits named events; listen to all our types
  for (const t of [
    "hello",
    "ping",
    "session_started",
    "session_list",
    "session_ended",
    "session_paused",
    "session_resumed",
    "node_added",
    "node_updated",
    "node_resolved",
    "node_committed",
    "hook_event",
  ]) {
    es.addEventListener(t, (e: MessageEvent) => handle(e.data));
  }
  es.onerror = () => {
    // browser auto-reconnects EventSource
  };
}

function handle(raw: string) {
  if (!raw) return;
  let ev: SseEvent;
  try {
    ev = JSON.parse(raw) as SseEvent;
  } catch {
    return;
  }
  const s = useStore.getState();
  switch (ev.type) {
    case "session_list":
      s.setSessions(ev.payload.sessions);
      break;
    case "session_started":
      s.setBrief(ev.payload.brief);
      if (!s.activeSessionId) s.setActive(ev.session_id);
      break;
    case "session_ended":
      s.setEnded(ev.payload.summary);
      break;
    case "session_paused":
      s.setPaused({ node_id: ev.payload.node_id, branch_id: ev.payload.branch_id });
      break;
    case "session_resumed":
      s.setResumed();
      break;
    case "node_added":
      s.addNode(ev.payload);
      break;
    case "node_updated":
      s.updateNode(ev.payload);
      break;
    case "node_resolved":
      s.setNodeResolved(ev.payload.node_id);
      break;
    case "node_committed":
      s.setNodeCommitted(ev.payload.node_id);
      break;
    case "hook_event":
      s.appendHook(ev.payload as HookTrace);
      break;
    default:
      break;
  }
}
