import { useStore } from "../store";
import { exportMarkdownUrl, postAction } from "../api";

export function Toolbar() {
  const sid = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const brief = useStore((s) => s.brief);
  const setActive = useStore((s) => s.setActive);
  const pendingNodeId = useStore((s) => s.pendingNodeId);
  const endedSummary = useStore((s) => s.endedSummary);
  const paused = useStore((s) => s.paused);
  const nodes = useStore((s) => s.nodes);

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
        {sessions.length > 1 && (
          <select
            className="gc-select"
            value={sid ?? ""}
            onChange={(e) => setActive(e.target.value)}
          >
            <option value="" disabled>
              session…
            </option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id.slice(0, 6)} — {s.brief.slice(0, 32)}
              </option>
            ))}
          </select>
        )}
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
    </header>
  );
}
