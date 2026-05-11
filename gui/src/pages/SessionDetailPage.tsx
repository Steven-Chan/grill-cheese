import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SessionProvider, useSession } from "../SessionContext";
import { BriefBanner } from "../components/BriefBanner";
import { BigCard } from "../components/BigCard";
import { SidebarHistory } from "../components/SidebarHistory";
import { EndedHistoryView } from "./EndedHistoryView";
import { exportMarkdownUrl, postAction, type ActionRejection } from "../api";

export function SessionDetailPage() {
  const { sid } = useParams<{ sid: string }>();
  if (!sid) return null;
  return (
    <SessionProvider sid={sid}>
      <DetailShell />
    </SessionProvider>
  );
}

function DetailShell() {
  const { state } = useSession();
  const [toast, setToast] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [wrappingUp, setWrappingUp] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const showWrapUp = state.loaded && state.status !== "ended" && state.nodeOrder.length > 0;

  // wrap-up targets the latest node — covers the idle case (no pending) too
  const onWrapUp = async () => {
    if (wrappingUp) return;
    const target = state.nodeOrder[state.nodeOrder.length - 1];
    if (!target) return;
    setWrappingUp(true);
    try {
      await postAction(state.sid, target, "stop");
    } catch (e) {
      const rej = e as ActionRejection;
      if (rej && typeof rej.status === "number") {
        setToast(`Wrap-up rejected: ${rej.err ?? rej.status}`);
      } else {
        setToast("Network error");
      }
    } finally {
      setWrappingUp(false);
    }
  };

  return (
    <div className="gc-page gc-detail-page">
      <header className="gc-detail-header">
        <div className="gc-detail-head-top">
          <Link to="/sessions" className="gc-back-link">
            ← sessions
          </Link>
          <h1 className="gc-detail-title">{state.title ?? state.sid}</h1>
          <div className="gc-detail-actions">
            {state.status !== "ended" && state.nodeOrder.length > 0 && (
              <button
                type="button"
                className="gc-btn gc-btn-toolbar"
                onClick={() => setSidebarOpen((v) => !v)}
                title={sidebarOpen ? "Hide history" : "Show history"}
                aria-pressed={sidebarOpen}
              >
                {sidebarOpen ? "◧" : "◨"} history ({Math.max(0, state.nodeOrder.length - (state.pendingNodeId ? 1 : 0))})
              </button>
            )}
            <HeaderMenu
              showWrapUp={showWrapUp}
              wrappingUp={wrappingUp}
              onWrapUp={onWrapUp}
              exportUrl={exportMarkdownUrl(state.sid)}
            />
          </div>
        </div>
        <div className="gc-detail-head-chips">
          {state.project && <span className="gc-chip gc-chip-project">{state.project}</span>}
          <span className={`gc-chip gc-status-${state.status}`}>{state.status}</span>
        </div>
        <BriefBanner brief={state.brief} />
      </header>
      <main className="gc-detail-body">
        {!state.loaded ? (
          <div className="gc-empty">loading…</div>
        ) : state.status === "ended" ? (
          <EndedHistoryView />
        ) : (
          <ActiveLayout onToast={setToast} sidebarOpen={sidebarOpen} />
        )}
      </main>
      {toast && (
        <div className="gc-toast" role="status">
          <span>{toast}</span>
          <button className="gc-toast-x" aria-label="dismiss" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function HeaderMenu({
  showWrapUp,
  wrappingUp,
  onWrapUp,
  exportUrl,
}: {
  showWrapUp: boolean;
  wrappingUp: boolean;
  onWrapUp: () => void;
  exportUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="gc-menu" ref={ref}>
      <button
        type="button"
        className="gc-btn gc-btn-toolbar"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="gc-header-menu-pop"
        title="More actions"
      >
        ⋯
      </button>
      {open && (
        <div id="gc-header-menu-pop" className="gc-menu-pop" role="menu">
          {showWrapUp && (
            <button
              type="button"
              role="menuitem"
              className="gc-menu-item"
              onClick={() => {
                setOpen(false);
                onWrapUp();
              }}
              disabled={wrappingUp}
              title="Wrap up the session — Claude will draft a summary"
            >
              {wrappingUp ? "wrapping…" : "Wrap up"}
            </button>
          )}
          <a
            role="menuitem"
            className="gc-menu-item"
            href={exportUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
          >
            export .md
          </a>
        </div>
      )}
    </div>
  );
}

function ActiveLayout({
  onToast,
  sidebarOpen,
}: {
  onToast: (msg: string) => void;
  sidebarOpen: boolean;
}) {
  return (
    <div className={`gc-active${sidebarOpen ? " with-sidebar" : ""}`}>
      <div className="gc-active-card">
        <BigCard onToast={onToast} />
      </div>
      {sidebarOpen && (
        <aside className="gc-active-sidebar">
          <SidebarHistory open={sidebarOpen} />
        </aside>
      )}
    </div>
  );
}
