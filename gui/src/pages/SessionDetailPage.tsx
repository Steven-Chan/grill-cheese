import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SessionProvider, useSession } from "../SessionContext";
import { BriefBanner } from "../components/BriefBanner";
import { BigCard } from "../components/BigCard";
import { FireAnimation } from "../components/FireAnimation";
import { ScoreChip } from "../components/ScoreChip";
import { SidebarHistory } from "../components/SidebarHistory";
import { EndedHistoryView } from "./EndedHistoryView";
import { exportMarkdownUrl, postJumpToCmux, postWrap, type ActionRejection } from "../api";

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
  // null = follow live pending. set = pinned to a specific past node in BigCard slot.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // chip (icon-only, always visible): fire iff Claude is being waited on,
  // otherwise cheese. Flipping back to fire on the next waiting edge is fine.
  const waiting =
    state.loaded &&
    state.status === "active" &&
    (state.pendingNodeId === null || state.wrapping);
  const chipMode: "fire" | "cheese" = waiting ? "fire" : "cheese";

  // clear the pin if the session ends (EndedHistoryView takes over) or the node vanishes
  useEffect(() => {
    if (!selectedNodeId) return;
    if (state.status === "ended" || !state.nodes[selectedNodeId]) setSelectedNodeId(null);
  }, [selectedNodeId, state.nodes, state.status]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const showWrapUp =
    state.loaded && state.status !== "ended" && state.nodeOrder.length > 0 && !state.wrapping;
  const canJumpToCmux = !!state.cmux?.workspace_id;
  const [jumping, setJumping] = useState(false);

  // Client-side pick-rate badge — mean of node.recommendation_score over the
  // nodes that have one (matches server's emit_performance_entry formula).
  // Cheap to compute on every render; runs over the in-memory node map only.
  const pickRate = useMemo(() => {
    const scores: number[] = [];
    for (const n of Object.values(state.nodes)) {
      if (typeof n.recommendation_score === "number") scores.push(n.recommendation_score);
    }
    if (scores.length === 0) return { score: null as number | null, count: 0 };
    return { score: scores.reduce((a, b) => a + b, 0) / scores.length, count: scores.length };
  }, [state.nodes]);

  const onJumpToCmux = async () => {
    if (jumping) return;
    setJumping(true);
    try {
      await postJumpToCmux(state.sid);
    } catch (e) {
      const rej = e as ActionRejection;
      if (rej && typeof rej.status === "number") {
        setToast(`Jump failed: ${rej.err ?? rej.status}`);
      } else {
        setToast("Network error");
      }
    } finally {
      setJumping(false);
    }
  };

  // Session-level wrap-up — no node id. Server emits session_wrap; skill
  // wakes and pushes the summary card.
  const onWrapUp = async () => {
    if (wrappingUp) return;
    setWrappingUp(true);
    try {
      await postWrap(state.sid);
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
            {canJumpToCmux && (
              <button
                type="button"
                className="gc-btn gc-btn-toolbar"
                onClick={onJumpToCmux}
                disabled={jumping}
                title="Focus the cmux pane running this Claude Code session"
              >
                {jumping ? "jumping…" : "↗ cmux"}
              </button>
            )}
            {state.status !== "ended" && state.nodeOrder.length > 0 && (
              <button
                type="button"
                className="gc-btn gc-btn-toolbar"
                onClick={() => setSidebarOpen((v) => !v)}
                title={sidebarOpen ? "Hide history" : "Show history"}
                aria-pressed={sidebarOpen}
              >
                {sidebarOpen ? "◧" : "◨"} history ({state.nodeOrder.length})
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
          {state.status === "ended" && pickRate.count > 0 && (
            <ScoreChip score={pickRate.score} count={pickRate.count} />
          )}
        </div>
        <BriefBanner brief={state.brief} />
      </header>
      <main className="gc-detail-body">
        {!state.loaded ? (
          <div className="gc-empty">loading…</div>
        ) : state.status === "ended" ? (
          <EndedHistoryView />
        ) : (
          <ActiveLayout
            onToast={setToast}
            sidebarOpen={sidebarOpen}
            setSidebarOpen={setSidebarOpen}
            selectedNodeId={selectedNodeId}
            onSelect={setSelectedNodeId}
          />
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
      <div className="gc-detail-fab" aria-hidden="true">
        <FireAnimation size={48} state={chipMode} fireShrinkMs={200} />
      </div>
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
  setSidebarOpen,
  selectedNodeId,
  onSelect,
}: {
  onToast: (msg: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  selectedNodeId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="gc-active">
      <div className="gc-active-card">
        <BigCard
          onToast={onToast}
          selectedNodeId={selectedNodeId}
          onClearSelection={() => onSelect(null)}
        />
      </div>
      {sidebarOpen && (
        <aside className="gc-active-sidebar">
          <SidebarHistory
            open={sidebarOpen}
            selectedNodeId={selectedNodeId}
            onSelect={onSelect}
            onClose={() => setSidebarOpen(false)}
          />
        </aside>
      )}
    </div>
  );
}
