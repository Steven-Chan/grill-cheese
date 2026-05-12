import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPerformance, fetchRetroPreview, postRetro } from "../api";
import type { RetroPreview, RetroResult } from "../api";
import { ScoreChip } from "../components/ScoreChip";
import type { PerformanceEntry } from "../types";

// /performance — perf log roll-up. Today on top with KPI strip; collapsed
// dated history below. Backed by /api/performance (flat list newest-first,
// see ADR-0003). GUI does date grouping client-side.

const HISTORY_DAYS = 7;

export function PerformancePage() {
  const [entries, setEntries] = useState<PerformanceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPerformance()
      .then(setEntries)
      .catch((e) => setError(String(e)));
  }, []);

  const { today, history } = useMemo(() => groupByDate(entries ?? []), [entries]);
  const todayMean = useMemo(() => meanScore(today), [today]);
  const projects = useMemo(() => uniqueProjects(entries ?? []), [entries]);

  return (
    <div className="gc-page gc-perf-page">
      <header className="gc-perf-header">
        <Link to="/sessions" className="gc-back-link">← sessions</Link>
        <h1>Performance</h1>
        <p className="gc-dim">Agent recommendation pick rate per session.</p>
        {projects.length > 0 && <RetroBar projects={projects} />}
      </header>

      {error && <div className="gc-empty">failed to load: {error}</div>}
      {!error && entries === null && <div className="gc-empty">loading…</div>}
      {!error && entries !== null && entries.length === 0 && (
        <div className="gc-empty">
          <p>no ended sessions yet</p>
          <p className="gc-dim">Per-session pick rate is logged when a session reaches a verdict.</p>
        </div>
      )}

      {entries !== null && entries.length > 0 && (
        <>
          <section className="gc-perf-kpi-row">
            <KpiCard label="Today, avg pick rate" value={todayMean == null ? "—" : `${Math.round(todayMean * 100)}%`} />
            <KpiCard label="Today, sessions" value={String(today.length)} />
            <KpiCard label="Today, decisions" value={String(sumDecisions(today))} />
          </section>

          <section className="gc-perf-section">
            <h2>Today</h2>
            {today.length === 0 ? (
              <p className="gc-dim">no sessions ended today.</p>
            ) : (
              <ul className="gc-perf-list">
                {today.map((e) => <PerfRow key={e.session_id} entry={e} />)}
              </ul>
            )}
          </section>

          <section className="gc-perf-section">
            <h2>Last {HISTORY_DAYS} days</h2>
            <HistoryGroups groups={history} />
          </section>
        </>
      )}
    </div>
  );
}

interface RetroToast {
  kind: "ok" | "empty" | "err";
  msg: string;
}

function RetroBar({ projects }: { projects: string[] }) {
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [toast, setToast] = useState<RetroToast | null>(null);

  return (
    <div className="gc-perf-retro-bar">
      <span className="gc-perf-retro-label">retrospective:</span>
      {projects.map((p) => (
        <button
          key={p}
          type="button"
          className="gc-perf-retro-btn"
          onClick={() => {
            setToast(null);
            setOpenProject(p);
          }}
        >
          {p}
        </button>
      ))}
      {toast && (
        <span className={`gc-perf-retro-toast gc-perf-retro-toast-${toast.kind}`} role="status">
          {toast.msg}
        </span>
      )}
      {openProject !== null && (
        <RetroPreviewModal
          project={openProject}
          onClose={() => setOpenProject(null)}
          onResult={(t) => {
            setToast(t);
            setOpenProject(null);
          }}
        />
      )}
    </div>
  );
}

interface RetroPreviewModalProps {
  project: string;
  onClose: () => void;
  onResult: (toast: RetroToast) => void;
}

function RetroPreviewModal({ project, onClose, onResult }: RetroPreviewModalProps) {
  const [preview, setPreview] = useState<RetroPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchRetroPreview(project)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e) => { if (!cancelled) setErr(String(e)); });
    return () => { cancelled = true; };
  }, [project]);

  // Esc-to-close on modal mount. Removed on unmount.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function launch() {
    if (!preview || preview.is_empty) return;
    setLaunching(true);
    try {
      const r: RetroResult = await postRetro(project);
      if (r.empty) {
        onResult({ kind: "empty", msg: `${project}: nothing to retro since last marker.` });
      } else if (r.ok) {
        onResult({
          kind: "ok",
          msg: `${project}: launched retro on ${r.disagreed_count ?? 0} disagreed nodes across ${r.session_count ?? 0} sessions.`,
        });
      } else {
        const fallback = r.fallback ? ` ${r.fallback}` : "";
        onResult({ kind: "err", msg: `${project}: ${r.err || "retro failed"}.${fallback}` });
      }
    } catch (e) {
      onResult({ kind: "err", msg: `${project}: ${String(e)}` });
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="gc-retro-modal-overlay" role="dialog" aria-modal="true" aria-label={`Retrospective preview for ${project}`}>
      <div className="gc-retro-modal-card">
        <header className="gc-retro-modal-header">
          <h2>retrospective preview — <code>{project}</code></h2>
          <button type="button" className="gc-retro-modal-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="gc-retro-modal-body">
          {err && <p className="gc-retro-modal-err">failed to load: {err}</p>}
          {!err && preview === null && <p className="gc-dim">loading preview…</p>}
          {preview !== null && <RetroPreviewBody preview={preview} />}
        </div>
        <footer className="gc-retro-modal-footer">
          <button type="button" className="gc-retro-modal-btn" onClick={onClose} disabled={launching}>
            cancel
          </button>
          <button
            type="button"
            className="gc-retro-modal-btn gc-retro-modal-btn-primary"
            onClick={launch}
            disabled={launching || preview === null || preview.is_empty}
            aria-busy={launching}
          >
            {launching ? "launching…" : "launch retro"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function RetroPreviewBody({ preview }: { preview: RetroPreview }) {
  if (preview.is_empty) {
    const since = preview.since ? new Date(preview.since).toLocaleString() : "the project start";
    return (
      <div>
        <p>all clear — no new disagreements since <code>{since}</code>.</p>
        <p className="gc-dim">a retro now would be a no-op; come back after more grill sessions end.</p>
      </div>
    );
  }
  const since = preview.since ? new Date(preview.since).toLocaleString() : "the project start";
  return (
    <div>
      <ul className="gc-retro-modal-stats">
        <li><strong>{preview.counts.disagreed}</strong> disagreed nodes</li>
        <li><strong>{preview.counts.sessions}</strong> sessions</li>
        <li>since <code>{since}</code></li>
      </ul>
      <h3 className="gc-retro-modal-subhead">disagreed questions</h3>
      <ul className="gc-retro-modal-question-list">
        {preview.disagreed_questions.map((q) => (
          <li key={`${q.session_id}-${q.node_id}`}>
            <Link to={`/sessions/${q.session_id}`} className="gc-retro-modal-q-link">
              <span className="gc-retro-modal-q-text">{q.question}</span>
              {q.session_title && (
                <span className="gc-retro-modal-q-session">{q.session_title}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {preview.truncated && (
        <p className="gc-dim">…list truncated; agent will see all of them.</p>
      )}
    </div>
  );
}

function PerfRow({ entry }: { entry: PerformanceEntry }) {
  // Link to /sessions/<sid> — landing page handles "session pruned" via the
  // snapshot 404 (existing behaviour). No special handling needed here.
  const title = entry.title || entry.session_id.slice(0, 8);
  const isRetro = entry.kind === "retro";
  return (
    <li className="gc-perf-row">
      <Link to={`/sessions/${entry.session_id}`} className="gc-perf-row-link">
        <span className="gc-perf-row-title">{title}</span>
        <span className="gc-perf-row-chips">
          {isRetro && <span className="gc-chip gc-chip-retro">retro</span>}
          {entry.project && <span className="gc-chip gc-chip-project">{entry.project}</span>}
          <span className="gc-chip gc-chip-verdict">{entry.verdict}</span>
          {!isRetro && <ScoreChip score={entry.score} count={entry.decision_count} />}
        </span>
        <span className="gc-perf-row-time">{fmtTime(entry.ended_at)}</span>
      </Link>
    </li>
  );
}

function HistoryGroups({ groups }: { groups: Array<{ date: string; entries: PerformanceEntry[] }> }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (groups.length === 0) return <p className="gc-dim">no history yet.</p>;
  return (
    <ul className="gc-perf-history">
      {groups.map((g) => {
        const isOpen = !!open[g.date];
        const mean = meanScore(g.entries);
        return (
          <li key={g.date} className="gc-perf-history-day">
            <button
              type="button"
              className="gc-perf-history-toggle"
              onClick={() => setOpen((s) => ({ ...s, [g.date]: !s[g.date] }))}
              aria-expanded={isOpen}
            >
              <span className="gc-perf-history-arrow">{isOpen ? "▼" : "▶"}</span>
              <span className="gc-perf-history-date">{g.date}</span>
              <span className="gc-perf-history-meta">
                {g.entries.length} session{g.entries.length === 1 ? "" : "s"}
                {mean != null && ` · avg ${Math.round(mean * 100)}%`}
              </span>
            </button>
            {isOpen && (
              <ul className="gc-perf-list gc-perf-list-nested">
                {g.entries.map((e) => <PerfRow key={e.session_id} entry={e} />)}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="gc-perf-kpi">
      <div className="gc-perf-kpi-value">{value}</div>
      <div className="gc-perf-kpi-label">{label}</div>
    </div>
  );
}

// ---- helpers ----

function localDateKey(ts: number): string {
  // YYYY-MM-DD in local time for grouping.
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function groupByDate(entries: PerformanceEntry[]): {
  today: PerformanceEntry[];
  history: Array<{ date: string; entries: PerformanceEntry[] }>;
} {
  const todayKey = localDateKey(Date.now() / 1000);
  const cutoff = Date.now() / 1000 - HISTORY_DAYS * 86400;
  const byDate = new Map<string, PerformanceEntry[]>();
  const today: PerformanceEntry[] = [];
  for (const e of entries) {
    const key = localDateKey(e.ended_at);
    if (key === todayKey) {
      today.push(e);
      continue;
    }
    if (e.ended_at < cutoff) continue;
    const arr = byDate.get(key);
    if (arr) arr.push(e);
    else byDate.set(key, [e]);
  }
  const history = Array.from(byDate.entries())
    .map(([date, es]) => ({ date, entries: es }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return { today, history };
}

function uniqueProjects(entries: PerformanceEntry[]): string[] {
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.project) seen.add(e.project);
  }
  return Array.from(seen).sort();
}

function meanScore(entries: PerformanceEntry[]): number | null {
  // Retro sessions excluded: their "score" is alignment-on-proposals, not
  // agent-vs-user pick rate. Same logic as ADR-0003 nulls-skipped mean.
  const scored = entries.filter((e) => e.score != null && e.kind !== "retro") as Array<
    PerformanceEntry & { score: number }
  >;
  if (scored.length === 0) return null;
  return scored.reduce((acc, e) => acc + e.score, 0) / scored.length;
}

function sumDecisions(entries: PerformanceEntry[]): number {
  return entries.reduce(
    (acc, e) => acc + (e.kind === "retro" ? 0 : e.decision_count || 0),
    0,
  );
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
