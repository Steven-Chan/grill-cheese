import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SessionProvider, useSession } from "../SessionContext";
import { BriefBanner } from "../components/BriefBanner";
import { BigCard } from "../components/BigCard";
import { SidebarHistory } from "../components/SidebarHistory";
import { EndedHistoryView } from "./EndedHistoryView";
import { exportMarkdownUrl } from "../api";

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

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  return (
    <div className="gc-page gc-detail-page">
      <header className="gc-detail-header">
        <div className="gc-detail-head-top">
          <Link to="/sessions" className="gc-back-link">
            ← sessions
          </Link>
          <h1 className="gc-detail-title">{state.title ?? state.sid}</h1>
          <div className="gc-detail-actions">
            {state.project && <span className="gc-chip gc-chip-project">{state.project}</span>}
            <span className={`gc-chip gc-status-${state.status}`}>{state.status}</span>
            <a className="gc-export-link" href={exportMarkdownUrl(state.sid)} target="_blank" rel="noreferrer">
              export .md
            </a>
          </div>
        </div>
        <BriefBanner brief={state.brief} />
      </header>
      <main className="gc-detail-body">
        {!state.loaded ? (
          <div className="gc-empty">loading…</div>
        ) : state.status === "ended" ? (
          <EndedHistoryView />
        ) : (
          <ActiveLayout onToast={setToast} />
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

function ActiveLayout({ onToast }: { onToast: (msg: string) => void }) {
  return (
    <div className="gc-active">
      <div className="gc-active-card">
        <BigCard onToast={onToast} />
      </div>
      <aside className="gc-active-sidebar">
        <SidebarHistory />
      </aside>
    </div>
  );
}
