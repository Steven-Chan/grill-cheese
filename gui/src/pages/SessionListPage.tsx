import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { deleteSession, listSessions } from "../api";
import { FireAnimation } from "../components/FireAnimation";
import { openSse } from "../sse";
import { initialListState, listReducer } from "../state";
import type { SessionMeta, SseEvent } from "../types";

export function SessionListPage() {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(listReducer, initialListState);
  const [toast, setToast] = useState<string | null>(null);
  const [brandMode, setBrandMode] = useState<"fire" | "cheese">("fire");
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // brand flame cycles fire (7.5s) <-> cheese (3.5s) for charm
  useEffect(() => {
    const delay = brandMode === "fire" ? 7500 : 3500;
    const id = window.setTimeout(() => {
      setBrandMode((m) => (m === "fire" ? "cheese" : "fire"));
    }, delay);
    return () => window.clearTimeout(id);
  }, [brandMode]);

  // initial fetch
  useEffect(() => {
    listSessions()
      .then((r) => dispatchRef.current({ type: "set_sessions", sessions: r.sessions }))
      .catch(() => {});
  }, []);

  // global SSE — server re-broadcasts session_list on add/end/delete
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

  const sorted = useMemo(() => {
    const xs = [...state.sessions];
    xs.sort((a, b) => {
      if (a.has_pending !== b.has_pending) return a.has_pending ? -1 : 1;
      return b.started_at - a.started_at;
    });
    return xs;
  }, [state.sessions]);

  const onDelete = async (meta: SessionMeta) => {
    if (meta.status !== "ended") {
      const ok = window.confirm(
        `Delete session "${displayTitle(meta)}"?\nMoves to trash; wiped on next server restart.`
      );
      if (!ok) return;
    }
    try {
      await deleteSession(meta.id);
    } catch {
      setToast("delete failed");
    }
  };

  return (
    <div className="gc-page gc-list-page">
      <header className="gc-list-header">
        <h1>
          <FireAnimation size={32} state={brandMode} />
          <span>grill·<span className="gc-brand-cheese">cheese</span></span>
        </h1>
        <p className="gc-dim">
          Server: <code>127.0.0.1:7878</code>
        </p>
      </header>
      {!state.loaded ? (
        <div className="gc-empty">loading…</div>
      ) : sorted.length === 0 ? (
        <div className="gc-empty">
          <p>no sessions yet</p>
          <p className="gc-dim">
            Run <code>claude</code> in your project and ask it to <code>/grill-cheese</code> a plan.
          </p>
        </div>
      ) : (
        <ul className="gc-session-list">
          {sorted.map((s) => (
            <SessionRow
              key={s.id}
              meta={s}
              onPick={() => navigate(`/sessions/${s.id}`)}
              onDelete={() => onDelete(s)}
            />
          ))}
        </ul>
      )}
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

function displayTitle(meta: SessionMeta): string {
  return meta.title || (meta.brief ? meta.brief.slice(0, 80) : "(untitled)");
}

function relTime(ts: number): string {
  const sec = Math.max(0, Date.now() / 1000 - ts);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function SessionRow({
  meta,
  onPick,
  onDelete,
}: {
  meta: SessionMeta;
  onPick: () => void;
  onDelete: () => void;
}) {
  const title = displayTitle(meta);
  return (
    <li className="gc-session-row-wrap">
      <button type="button" className="gc-session-row" onClick={onPick}>
        <span className="gc-session-star" aria-hidden>
          {meta.has_pending ? "●" : ""}
        </span>
        <span className="gc-session-text">
          <strong className="gc-session-title">{title}</strong>
          {meta.brief && <span className="gc-session-brief-secondary">{meta.brief}</span>}
        </span>
        <span className="gc-session-chips">
          {meta.project && <span className="gc-chip gc-chip-project">{meta.project}</span>}
          <span className={`gc-chip gc-status-${meta.status}`}>{meta.status}</span>
        </span>
        <span className="gc-session-meta">
          {meta.id.slice(0, 6)} · {relTime(meta.started_at)}
        </span>
      </button>
      <button
        type="button"
        className="gc-session-delete"
        aria-label="Delete session"
        title="Delete session"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        ×
      </button>
    </li>
  );
}
