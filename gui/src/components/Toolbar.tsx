import { useMemo, useState } from "react";
import { useStore } from "../store";
import { exportMarkdownUrl, postAction } from "../api";
import { SessionPicker } from "./SessionPicker";

export function Toolbar() {
  const sid = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const title = useStore((s) => s.title);
  const brief = useStore((s) => s.brief);
  const pendingNodeId = useStore((s) => s.pendingNodeId);
  const nodes = useStore((s) => s.nodes);
  const [pickerOpen, setPickerOpen] = useState(false);

  // count of OTHER sessions with pending action — drives the badge
  const pendingOthers = useMemo(
    () => sessions.filter((s) => s.has_pending && s.id !== sid).length,
    [sessions, sid]
  );

  // Hide "wrap up" when the pending node is a summary — the summary card owns
  // the verdict via its own buttons.
  const pendingIsSummary = pendingNodeId
    ? nodes[pendingNodeId]?.kind === "summary"
    : false;

  const stop = async () => {
    if (!sid || !pendingNodeId) return;
    await postAction(sid, pendingNodeId, "stop");
  };

  // title fallback for legacy sessions where title is null
  const displayTitle = sid ? (title || (brief ? brief.slice(0, 80) : "")) : "";
  const meta = sid ? sessions.find((s) => s.id === sid) : undefined;
  const isEnded = meta?.status === "ended";

  return (
    <header className="gc-toolbar">
      <div className="gc-brand-logo" aria-label="grill·cheese">
        {/* placeholder mark — cheese-wedge silhouette */}
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
          <path
            d="M3 17 L21 7 L21 17 Z"
            fill="var(--gc-rec)"
            stroke="var(--gc-rec)"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <circle cx="9" cy="14" r="1" fill="var(--gc-bg)" />
          <circle cx="14" cy="12" r="0.9" fill="var(--gc-bg)" />
          <circle cx="17" cy="14.5" r="0.7" fill="var(--gc-bg)" />
        </svg>
      </div>
      {sid && displayTitle && (
        <h1 className="gc-toolbar-title" title={displayTitle}>
          {displayTitle}
        </h1>
      )}
      {sid && isEnded && <span className="gc-toolbar-ended">ended</span>}
      <div className="gc-actions">
        {sid && (
          <>
            <a className="gc-btn ghost" href={exportMarkdownUrl(sid)} target="_blank" rel="noreferrer">
              export .md
            </a>
            {pendingNodeId && !pendingIsSummary && (
              <button className="gc-btn warn" onClick={stop}>
                wrap up
              </button>
            )}
          </>
        )}
        <button
          type="button"
          className="gc-btn gc-sessions-btn"
          onClick={() => setPickerOpen(true)}
        >
          Sessions
          {pendingOthers > 0 && (
            <span className="gc-sessions-badge" aria-label={`${pendingOthers} other sessions pending`}>
              {pendingOthers}
            </span>
          )}
        </button>
      </div>
      <SessionPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </header>
  );
}
