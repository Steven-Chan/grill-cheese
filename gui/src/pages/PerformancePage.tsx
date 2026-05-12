import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPerformance } from "../api";
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

  return (
    <div className="gc-page gc-perf-page">
      <header className="gc-perf-header">
        <Link to="/sessions" className="gc-back-link">← sessions</Link>
        <h1>Performance</h1>
        <p className="gc-dim">Agent recommendation pick rate per session.</p>
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

function PerfRow({ entry }: { entry: PerformanceEntry }) {
  // Link to /sessions/<sid> — landing page handles "session pruned" via the
  // snapshot 404 (existing behaviour). No special handling needed here.
  const title = entry.title || entry.session_id.slice(0, 8);
  return (
    <li className="gc-perf-row">
      <Link to={`/sessions/${entry.session_id}`} className="gc-perf-row-link">
        <span className="gc-perf-row-title">{title}</span>
        <span className="gc-perf-row-chips">
          {entry.project && <span className="gc-chip gc-chip-project">{entry.project}</span>}
          <span className="gc-chip gc-chip-verdict">{entry.verdict}</span>
          <ScoreChip score={entry.score} count={entry.decision_count} />
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

function meanScore(entries: PerformanceEntry[]): number | null {
  const scored = entries.filter((e) => e.score != null) as Array<PerformanceEntry & { score: number }>;
  if (scored.length === 0) return null;
  return scored.reduce((acc, e) => acc + e.score, 0) / scored.length;
}

function sumDecisions(entries: PerformanceEntry[]): number {
  return entries.reduce((acc, e) => acc + (e.decision_count || 0), 0);
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
