import { useEffect } from "react";
import { Canvas } from "./components/Canvas";
import { Toolbar } from "./components/Toolbar";
import { connectSse } from "./sse";
import { useStore } from "./store";
import { listSessions } from "./api";

export default function App() {
  const sid = useStore((s) => s.activeSessionId);
  const setActive = useStore((s) => s.setActive);
  const setSessions = useStore((s) => s.setSessions);
  const toast = useStore((s) => s.toast);
  const setToast = useStore((s) => s.setToast);

  useEffect(() => {
    // initial: connect global stream so we discover the first session
    connectSse(null);
    // also pull session list explicitly (in case stream missed it)
    listSessions()
      .then((res) => {
        setSessions(res.sessions);
        if (!useStore.getState().activeSessionId && res.sessions.length > 0) {
          setActive(res.sessions[res.sessions.length - 1].id);
        }
      })
      .catch(() => {});
  }, [setActive, setSessions]);

  useEffect(() => {
    if (sid) connectSse(sid);
  }, [sid]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast, setToast]);

  return (
    <div className="gc-app">
      <Toolbar />
      <main className="gc-canvas-wrap">
        {sid ? <Canvas /> : <EmptyState />}
      </main>
      {toast && (
        <div className="gc-toast" role="status">
          <span>{toast}</span>
          <button
            className="gc-toast-x"
            aria-label="dismiss"
            onClick={() => setToast(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="gc-empty">
      <h1>grill·cheese</h1>
      <p>
        Run <code>claude</code> in your project, then ask it to <code>/grill-cheese</code> a plan or
        proposal. Decisions stream here.
      </p>
      <p className="gc-dim">
        Server: <code>127.0.0.1:7878</code> · MCP: <code>/mcp</code> · Hooks: <code>/hooks</code>
      </p>
    </div>
  );
}
