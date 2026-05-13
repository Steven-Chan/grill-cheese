import type { SessionMeta } from "../types";
import { ScoreChip } from "./ScoreChip";

export type SessionRowVariant = "needsYou" | "active" | "ended";

export function displayTitle(meta: SessionMeta): string {
  return meta.title || (meta.brief ? meta.brief.slice(0, 80) : "(untitled)");
}

export function relTime(ts: number): string {
  const sec = Math.max(0, Date.now() / 1000 - ts);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function SessionRow({
  meta,
  variant,
  onPick,
  onDelete,
}: {
  meta: SessionMeta;
  variant: SessionRowVariant;
  onPick: () => void;
  onDelete: () => void;
}) {
  const title = displayTitle(meta);
  return (
    <li className={`gc-session-row-wrap gc-row-${variant}`}>
      <button type="button" className="gc-session-row" onClick={onPick}>
        <span className="gc-session-text">
          <strong className="gc-session-title">{title}</strong>
          {meta.brief && <span className="gc-session-brief-secondary">{meta.brief}</span>}
        </span>
        <span className="gc-session-chips">
          {meta.project && <span className="gc-chip gc-chip-project">{meta.project}</span>}
          {variant === "ended" && <ScoreChip score={meta.score} count={meta.decision_count} />}
        </span>
        <span className="gc-session-meta">
          {relTime(meta.started_at)}
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
