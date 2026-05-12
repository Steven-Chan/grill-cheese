import type { SessionMeta } from "../types";
import { SessionRow } from "./SessionRow";

export function NeedsYouBar({
  rows,
  onPick,
  onDelete,
}: {
  rows: SessionMeta[];
  onPick: (s: SessionMeta) => void;
  onDelete: (s: SessionMeta) => void;
}) {
  return (
    <section className="gc-needs-you-bar" aria-label="Needs your attention">
      <header className="gc-needs-you-header">
        Needs you
        {rows.length > 0 && <span className="gc-count"> ({rows.length})</span>}
      </header>
      {rows.length === 0 ? (
        <div className="gc-needs-you-empty">All clear — nothing waiting on you.</div>
      ) : (
        <ul className="gc-session-list">
          {rows.map((s) => (
            <SessionRow
              key={s.id}
              meta={s}
              variant="needsYou"
              onPick={() => onPick(s)}
              onDelete={() => onDelete(s)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
