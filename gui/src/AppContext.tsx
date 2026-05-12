import { createContext, useContext, useEffect, useReducer, useRef, type ReactNode } from "react";
import { listSessions } from "./api";
import { openSse } from "./sse";
import { initialListState, listReducer, type ListAction, type ListState } from "./state";
import type { SseEvent } from "./types";

// App-level session list. Lifted from SessionListPage so the Cmd+P
// palette (mounted at App level) and any future cross-page surface can
// read the list without redundant fetch + SSE wiring per page.
// Single global SSE subscription handles session_list / session_deleted.

interface AppContextValue {
  list: ListState;
  dispatch: (a: ListAction) => void;
}

const Ctx = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [list, dispatch] = useReducer(listReducer, initialListState);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    listSessions()
      .then((r) => dispatchRef.current({ type: "set_sessions", sessions: r.sessions }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    return openSse(null, (ev: SseEvent) => {
      const d = dispatchRef.current;
      if (ev.type === "session_list") {
        d({ type: "set_sessions", sessions: ev.payload.sessions });
      } else if (ev.type === "session_deleted") {
        d({ type: "session_deleted", id: ev.session_id });
      }
    });
  }, []);

  return <Ctx.Provider value={{ list, dispatch }}>{children}</Ctx.Provider>;
}

export function useAppContext(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppContext outside <AppProvider>");
  return v;
}
