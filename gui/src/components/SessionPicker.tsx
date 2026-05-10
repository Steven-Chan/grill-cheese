import { useEffect, useMemo } from "react";
import { useStore } from "../store";
import type { SessionMeta } from "../types";

function relTime(ts: number): string {
  const sec = Math.max(0, Date.now() / 1000 - ts);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SessionPicker({ open, onClose }: Props) {
  const sessions = useStore((s) => s.sessions);
  const activeSid = useStore((s) => s.activeSessionId);
  const setActive = useStore((s) => s.setActive);

  // pending first, then started_at desc
  const sorted = useMemo(() => {
    const xs = [...sessions];
    xs.sort((a, b) => {
      if (a.has_pending !== b.has_pending) return a.has_pending ? -1 : 1;
      return b.started_at - a.started_at;
    });
    return xs;
  }, [sessions]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const pick = (sid: string) => {
    if (sid !== activeSid) setActive(sid);
    onClose();
  };

  return (
    <div className="gc-modal-backdrop" onClick={onClose}>
      <div
        className="gc-modal"
        role="dialog"
        aria-label="Sessions"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gc-modal-head">
          <span className="gc-modal-title">Sessions</span>
          <button className="gc-modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {sorted.length === 0 ? (
          <div className="gc-modal-empty">no sessions yet</div>
        ) : (
          <ul className="gc-session-list">
            {sorted.map((s) => (
              <SessionRow
                key={s.id}
                meta={s}
                isCurrent={s.id === activeSid}
                onPick={() => pick(s.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  meta,
  isCurrent,
  onPick,
}: {
  meta: SessionMeta;
  isCurrent: boolean;
  onPick: () => void;
}) {
  // * shown only for non-current sessions with pending action
  const showStar = meta.has_pending && !isCurrent;
  return (
    <li>
      <button
        type="button"
        className={`gc-session-row${isCurrent ? " current" : ""}`}
        onClick={onPick}
      >
        <span className="gc-session-star" aria-hidden>
          {showStar ? "●" : ""}
        </span>
        <span className="gc-session-brief">{meta.brief || <em>(no brief)</em>}</span>
        {meta.status !== "active" && (
          <span className={`gc-session-badge ${meta.status}`}>{meta.status}</span>
        )}
        <span className="gc-session-meta">
          · {meta.id.slice(0, 6)} · {relTime(meta.started_at)}
        </span>
      </button>
    </li>
  );
}
