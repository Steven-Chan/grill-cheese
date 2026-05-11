import { createContext, useContext, useEffect, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import { getSnapshot } from "./api";
import { openSse } from "./sse";
import {
  initialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
  type Snapshot,
} from "./state";
import type { DecisionNode, SseEvent } from "./types";

interface Ctx {
  state: SessionState;
  dispatch: React.Dispatch<SessionAction>;
}

const SessionCtx = createContext<Ctx | null>(null);

export function useSession(): Ctx {
  const v = useContext(SessionCtx);
  if (!v) throw new Error("useSession must be inside <SessionProvider>");
  return v;
}

interface Props {
  sid: string;
  children: ReactNode;
}

export function SessionProvider({ sid, children }: Props) {
  const [state, dispatch] = useReducer(sessionReducer, sid, initialSessionState);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // hydrate once per sid
  useEffect(() => {
    let alive = true;
    getSnapshot(sid)
      .then((snap: Snapshot) => {
        if (!alive) return;
        dispatchRef.current({ type: "hydrate", snapshot: snap });
      })
      .catch(() => {
        // server may not have the session yet — SSE will fill in
      });
    return () => {
      alive = false;
    };
  }, [sid]);

  // SSE stream per sid
  useEffect(() => {
    return openSse(sid, (ev: SseEvent) => {
      const d = dispatchRef.current;
      switch (ev.type) {
        case "session_started":
          d({
            type: "session_started",
            title: ev.payload.title,
            brief: ev.payload.brief,
            startedAt: ev.payload.started_at,
          });
          break;
        case "session_ended":
          d({ type: "session_ended", summary: ev.payload.summary });
          break;
        case "session_paused":
          d({
            type: "session_paused",
            paused: { node_id: ev.payload.node_id, branch_id: ev.payload.branch_id },
          });
          break;
        case "session_resumed":
          d({ type: "session_resumed" });
          break;
        case "node_added":
          d({ type: "node_added", node: ev.payload as DecisionNode });
          break;
        case "node_updated":
          d({ type: "node_updated", node: ev.payload as DecisionNode });
          break;
        case "node_resolved":
          d({ type: "node_resolved", node_id: ev.payload.node_id });
          break;
        case "node_committed": {
          const last = ev.payload.actions?.[ev.payload.actions.length - 1];
          d({ type: "node_committed", node_id: ev.payload.node_id, action: last?.action ?? null });
          break;
        }
        // hook_event, session_list, session_deleted, hello, ping → ignored per-session
        default:
          break;
      }
    });
  }, [sid]);

  return <SessionCtx.Provider value={{ state, dispatch }}>{children}</SessionCtx.Provider>;
}
