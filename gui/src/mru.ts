// MRU recency for the Cmd+P palette (ADR-0004 amendment).
// localStorage map: { [sessionId]: lastVisitedMs }.
// Written on SessionDetailPage route entry; read on palette open.

import type { SessionMeta } from "./types";

const KEY = "grillMru";
const CAP = 200; // LRU cap so cold storage doesn't grow unbounded

type Mru = Record<string, number>;

export function getMru(): Mru {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Mru;
    return {};
  } catch {
    return {};
  }
}

export function bumpMru(id: string): void {
  try {
    const cur = getMru();
    cur[id] = Date.now();
    const ids = Object.keys(cur);
    if (ids.length > CAP) {
      // drop the oldest until under cap
      ids.sort((a, b) => (cur[a] ?? 0) - (cur[b] ?? 0));
      for (const drop of ids.slice(0, ids.length - CAP)) delete cur[drop];
    }
    localStorage.setItem(KEY, JSON.stringify(cur));
  } catch {
    // quota / privacy mode — silent
  }
}

// Sort sessions for the palette. Bands: needs-you → active (by recency) →
// ended (by recency). Stable within each band.
//
// Recency for active sessions = MRU timestamp if visited, else
// `started_at * 1000`. started_at is server epoch SECONDS; bumpMru writes
// Date.now() MS. Scaling unifies the units AND surfaces fresh
// never-visited sessions near the top — a session just created via
// start_session is something the user likely wants to jump into, even
// though they haven't visited it yet.
export function rankSessions(sessions: SessionMeta[], mru: Mru = getMru()): SessionMeta[] {
  const scored = sessions.map((s, idx) => ({
    s,
    idx,
    needs: s.has_pending,
    ended: s.status === "ended",
    recency: mru[s.id] ?? s.started_at * 1000,
  }));
  scored.sort((a, b) => {
    if (a.needs !== b.needs) return a.needs ? -1 : 1;
    if (a.ended !== b.ended) return a.ended ? 1 : -1;
    if (a.recency !== b.recency) return b.recency - a.recency;
    return a.idx - b.idx;
  });
  return scored.map((x) => x.s);
}
