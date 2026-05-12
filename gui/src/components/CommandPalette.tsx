import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppContext } from "../AppContext";
import { useOverlay } from "../OverlayContext";
import { rankSessions } from "../mru";
import type { SessionMeta } from "../types";
import { displayTitle } from "./SessionRow";

// Cmd+P command palette (ADR-0004 amendment, ADR-0005 overlay rule).
// Nav-picker: pages + sessions. Title-only fuzzy. Keyboard-first.

type PageItem = { kind: "page"; id: string; label: string; to: string };
type SessionItem = { kind: "session"; id: string; meta: SessionMeta };
type Item = PageItem | SessionItem;

const PAGE_ITEMS: PageItem[] = [
  { kind: "page", id: "page:sessions", label: "Session list", to: "/sessions" },
  { kind: "page", id: "page:performance", label: "Performance", to: "/performance" },
];

// Subsequence fuzzy with contiguous-run bonus. Returns null on miss, else
// a score where lower = better match. Pure substring beats scattered hits;
// match-at-start beats match-deep.
function fuzzyScore(target: string, query: string): number | null {
  if (!query) return 0;
  const t = target.toLowerCase();
  const q = query.toLowerCase();
  const idx = t.indexOf(q);
  if (idx !== -1) return idx; // contiguous substring wins
  // subsequence fallback — every query char in order, sum gap distances
  let ti = 0;
  let score = 0;
  let lastHit = -1;
  for (let qi = 0; qi < q.length; qi++) {
    while (ti < t.length && t[ti] !== q[qi]) ti++;
    if (ti === t.length) return null;
    score += lastHit === -1 ? ti : ti - lastHit;
    lastHit = ti;
    ti++;
  }
  return 1000 + score; // worse than any contiguous hit
}

function itemLabel(item: Item): string {
  return item.kind === "page" ? item.label : displayTitle(item.meta);
}

function itemKey(item: Item): string {
  return item.id;
}

export function CommandPalette() {
  const { active, setOverlay } = useOverlay();
  const { list } = useAppContext();
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  const open = active === "palette";

  // Capture prior focus + autofocus input on open; restore on close.
  useEffect(() => {
    if (!open) return;
    lastFocusRef.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setFocusIdx(0);
    // Defer focus to next frame — overlay just rendered.
    queueMicrotask(() => inputRef.current?.focus());
    return () => {
      lastFocusRef.current?.focus?.();
    };
  }, [open]);

  // Ranked items: pages tail, sessions head (MRU-ranked, needs-you first).
  // When a query is typed, fuzzy scores override; pages can rise to top.
  const items = useMemo<Item[]>(() => {
    const sess: SessionItem[] = rankSessions(list.sessions).map((m) => ({
      kind: "session",
      id: `s:${m.id}`,
      meta: m,
    }));
    return [...sess, ...PAGE_ITEMS];
  }, [list.sessions]);

  const filtered = useMemo<Item[]>(() => {
    if (!query.trim()) return items;
    const scored: { item: Item; score: number }[] = [];
    for (const item of items) {
      const score = fuzzyScore(itemLabel(item), query);
      if (score !== null) scored.push({ item, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((x) => x.item);
  }, [items, query]);

  // Keep focus index in range as filter changes.
  useEffect(() => {
    if (focusIdx >= filtered.length) setFocusIdx(0);
  }, [filtered.length, focusIdx]);

  // Scroll focused row into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${focusIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusIdx, open]);

  if (!open) return null;

  const close = () => setOverlay(null);

  const commit = (item: Item) => {
    close();
    if (item.kind === "page") navigate(item.to);
    else navigate(`/sessions/${item.meta.id}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((i) => (filtered.length ? (i + 1) % filtered.length : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[focusIdx];
      if (item) commit(item);
    }
  };

  return (
    <div
      className="gc-palette-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="gc-palette-panel" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="gc-palette-input"
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setFocusIdx(0);
          }}
          placeholder="Jump to session or page…"
          aria-label="Search sessions and pages"
          aria-controls="gc-palette-list"
          aria-activedescendant={filtered[focusIdx] ? `gc-palette-item-${itemKey(filtered[focusIdx])}` : undefined}
        />
        <ul ref={listRef} id="gc-palette-list" className="gc-palette-list" role="listbox">
          {filtered.length === 0 && (
            <li className="gc-palette-empty">no matches</li>
          )}
          {filtered.map((item, idx) => (
            <PaletteRow
              key={itemKey(item)}
              item={item}
              idx={idx}
              focused={idx === focusIdx}
              onClick={() => commit(item)}
              onMouseEnter={() => setFocusIdx(idx)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function PaletteRow({
  item,
  idx,
  focused,
  onClick,
  onMouseEnter,
}: {
  item: Item;
  idx: number;
  focused: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  if (item.kind === "page") {
    return (
      <li
        id={`gc-palette-item-${itemKey(item)}`}
        data-idx={idx}
        className={`gc-palette-row gc-palette-row-page ${focused ? "is-focused" : ""}`}
        role="option"
        aria-selected={focused}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
      >
        <span className="gc-palette-row-title">{item.label}</span>
        <span className="gc-palette-row-kind">page</span>
      </li>
    );
  }
  const m = item.meta;
  const status = m.has_pending ? "needs-you" : m.status;
  return (
    <li
      id={`gc-palette-item-${itemKey(item)}`}
      data-idx={idx}
      className={`gc-palette-row gc-palette-row-session ${focused ? "is-focused" : ""}`}
      role="option"
      aria-selected={focused}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      <span className="gc-palette-row-title">{displayTitle(m)}</span>
      <span className="gc-palette-row-chips">
        {m.project && <span className="gc-chip gc-chip-project">{m.project}</span>}
        <span className={`gc-palette-status gc-palette-status-${status}`}>
          {status === "needs-you" ? "needs you" : status}
        </span>
      </span>
    </li>
  );
}
