import { useMemo, useState } from "react";
import { useStore } from "../store";
import { exportMarkdownUrl, postAction } from "../api";
import { SessionPicker } from "./SessionPicker";

export function Toolbar() {
  const sid = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const brief = useStore((s) => s.brief);
  const pendingNodeId = useStore((s) => s.pendingNodeId);
  const endedSummary = useStore((s) => s.endedSummary);
  const paused = useStore((s) => s.paused);
  const nodes = useStore((s) => s.nodes);
  const [pickerOpen, setPickerOpen] = useState(false);

  // count of OTHER sessions with pending action — drives the badge
  const pendingOthers = useMemo(
    () => sessions.filter((s) => s.has_pending && s.id !== sid).length,
    [sessions, sid]
  );

  const stop = async () => {
    if (!sid || !pendingNodeId) return;
    await postAction(sid, pendingNodeId, "stop");
  };

  return (
    <header className="gc-toolbar">
      <div className="gc-brand">
        <span className="gc-brand-mark">grill</span>
        <span className="gc-brand-dot">·</span>
        <span className="gc-brand-mark italic">cheese</span>
      </div>
      <div className="gc-brief">{brief || <em className="gc-dim">awaiting brief…</em>}</div>
      <div className="gc-actions">
        {sid && (
          <>
            <a className="gc-btn ghost" href={exportMarkdownUrl(sid)} target="_blank" rel="noreferrer">
              export .md
            </a>
            {pendingNodeId && (
              <button className="gc-btn warn" onClick={stop}>
                stop
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
      {paused && (
        <div className="gc-paused">
          <strong>paused</strong> — chatting in Claude Code about
          {paused.branch_id ? (
            (() => {
              const n = nodes[paused.node_id];
              const b = n?.branches.find((x) => x.id === paused.branch_id);
              return <> branch <em>{b?.label || paused.branch_id}</em></>;
            })()
          ) : (
            <> this question</>
          )}. Push another question from CC to resume.
        </div>
      )}
      {endedSummary && (
        <div className="gc-ended">
          <strong>ended:</strong> {endedSummary}
        </div>
      )}
      <SessionPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </header>
  );
}
