import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { deleteSession, listSessions } from "../api";
import { FireAnimation } from "../components/FireAnimation";
import { ListSection } from "../components/ListSection";
import { NeedsYouBar } from "../components/NeedsYouBar";
import { SessionRow, displayTitle } from "../components/SessionRow";
import { openSse } from "../sse";
import { initialListState, listReducer } from "../state";
import type { SessionMeta, SseEvent } from "../types";

const ENDED_PREVIEW_COUNT = 5;

export function SessionListPage() {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(listReducer, initialListState);
  const [toast, setToast] = useState<string | null>(null);
  const [brandMode, setBrandMode] = useState<"fire" | "cheese">("fire");
  const [showAllEnded, setShowAllEnded] = useState(false);
  const [clearingEnded, setClearingEnded] = useState(false);
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

  const { needsYou, active, ended } = useMemo(() => {
    const needsYou: SessionMeta[] = [];
    const active: SessionMeta[] = [];
    const ended: SessionMeta[] = [];
    for (const s of state.sessions) {
      if (s.has_pending) needsYou.push(s);
      else if (s.status === "ended") ended.push(s);
      else active.push(s);
    }
    const byTime = (a: SessionMeta, b: SessionMeta) => b.started_at - a.started_at;
    needsYou.sort(byTime);
    active.sort(byTime);
    ended.sort(byTime);
    return { needsYou, active, ended };
  }, [state.sessions]);

  const visibleEnded = showAllEnded ? ended : ended.slice(0, ENDED_PREVIEW_COUNT);
  const totalRows = needsYou.length + active.length + ended.length;

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

  const onClearEnded = async () => {
    if (clearingEnded || ended.length === 0) return;
    const ok = window.confirm(
      `Delete all ${ended.length} ended session${ended.length === 1 ? "" : "s"}?\nMoves to trash; wiped on next server restart.`
    );
    if (!ok) return;
    setClearingEnded(true);
    try {
      const results = await Promise.allSettled(ended.map((s) => deleteSession(s.id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        setToast(`${failed} of ${ended.length} deletes failed`);
      }
    } finally {
      setClearingEnded(false);
    }
  };

  const pick = (s: SessionMeta) => navigate(`/sessions/${s.id}`);

  return (
    <div className="gc-page gc-list-page">
      <header className="gc-list-header">
        <h1>
          <FireAnimation size={32} state={brandMode} />
          <span>grill·<span className="gc-brand-cheese">cheese</span></span>
        </h1>
        <p className="gc-dim">
          Server: <code>127.0.0.1:7878</code>
          {" · "}
          <Link to="/performance" className="gc-nav-link">performance</Link>
        </p>
      </header>
      {!state.loaded ? (
        <div className="gc-empty">loading…</div>
      ) : totalRows === 0 ? (
        <div className="gc-empty">
          <p>no sessions yet</p>
          <p className="gc-dim">
            Run <code>claude</code> in your project and ask it to <code>/grill-cheese</code> a plan.
          </p>
        </div>
      ) : (
        <div className="gc-list-body">
          <NeedsYouBar rows={needsYou} onPick={pick} onDelete={onDelete} />

          <ListSection title="Active" count={active.length}>
            {active.map((s) => (
              <SessionRow
                key={s.id}
                meta={s}
                variant="active"
                onPick={() => pick(s)}
                onDelete={() => onDelete(s)}
              />
            ))}
          </ListSection>

          <ListSection
            title="Ended"
            count={ended.length}
            actions={
              <button
                type="button"
                className="gc-section-clear"
                onClick={onClearEnded}
                disabled={clearingEnded}
                title="Delete all ended sessions"
              >
                {clearingEnded ? "clearing…" : "clear all"}
              </button>
            }
          >
            {visibleEnded.map((s) => (
              <SessionRow
                key={s.id}
                meta={s}
                variant="ended"
                onPick={() => pick(s)}
                onDelete={() => onDelete(s)}
              />
            ))}
            {!showAllEnded && ended.length > ENDED_PREVIEW_COUNT && (
              <li className="gc-ended-toggle-wrap">
                <button
                  type="button"
                  className="gc-ended-toggle"
                  onClick={() => setShowAllEnded(true)}
                >
                  show all ({ended.length})
                </button>
              </li>
            )}
          </ListSection>
        </div>
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
