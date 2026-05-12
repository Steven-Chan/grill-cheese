import { useEffect, useRef } from "react";

// Cheatsheet modal (ADR-0004). Opened from the `?` keystroke (non-textarea
// focus) via useShortcuts. Render gated by OverlayContext.active ===
// "cheatsheet" (ADR-0005). Esc + backdrop click call onClose, which the
// App-level mount points at setOverlay(null).

interface Binding {
  keys: string;
  effect: string;
}

interface Section {
  title: string;
  rows: Binding[];
}

const SECTIONS: Section[] = [
  {
    title: "Decision card",
    rows: [
      { keys: "↑ / ↓", effect: "Move focus across branches and Own Answer" },
      { keys: "Space", effect: "Toggle focused branch (multi-mode) / pick (single-mode)" },
      { keys: "Enter", effect: "Pick + submit (branch, single-mode) / jump to textarea (Own Answer)" },
      { keys: "Tab", effect: "On Own Answer row → focus the textarea" },
      { keys: "Esc (in textarea)", effect: "Return focus to Own Answer row" },
      { keys: "Cmd/Ctrl + B", effect: "Snap focus to the branch list from anywhere" },
      { keys: "Cmd/Ctrl + K", effect: "Focus composer (chat) from anywhere" },
      { keys: "Cmd/Ctrl + Enter", effect: "Submit toggled set (multi-mode) or with typed Own Answer" },
      { keys: "1 — 9", effect: "Jump focus to that branch by hint-chip index" },
    ],
  },
  {
    title: "Composer",
    rows: [
      { keys: "Cmd/Ctrl + K", effect: "Focus composer from anywhere" },
      { keys: "@", effect: "Open branch-mention popup" },
      { keys: "↑ / ↓ + Enter", effect: "Pick a branch in the mention popup" },
      { keys: "1 — 9", effect: "Pick branch by number in the mention popup" },
      { keys: "Cmd/Ctrl + Enter", effect: "Send chat message" },
      { keys: "Esc", effect: "Close mention popup; second Esc blurs composer" },
    ],
  },
  {
    title: "Global",
    rows: [
      { keys: "Cmd/Ctrl + P", effect: "Open command palette (jump to session or page)" },
      { keys: "?", effect: "Open this cheatsheet" },
      { keys: "Esc", effect: "Close cheatsheet / palette / sidebar / decision-map overlay" },
    ],
  },
];

export function CheatsheetModal({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    lastFocusRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    document.body.setAttribute("data-cheatsheet-open", "true");
    return () => {
      document.body.removeAttribute("data-cheatsheet-open");
      lastFocusRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="gc-cheatsheet-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="gc-cheatsheet-panel">
        <header className="gc-cheatsheet-head">
          <h2>Keyboard shortcuts</h2>
          <button
            ref={closeRef}
            type="button"
            className="gc-btn gc-btn-toolbar"
            onClick={onClose}
            aria-label="Close cheatsheet (Esc)"
            title="Close (Esc)"
          >
            Close
          </button>
        </header>
        <div className="gc-cheatsheet-body">
          {SECTIONS.map((s) => (
            <section key={s.title} className="gc-cheatsheet-section">
              <h3>{s.title}</h3>
              <dl>
                {s.rows.map((r) => (
                  <div key={r.keys} className="gc-cheatsheet-row">
                    <dt className="gc-cheatsheet-keys">{r.keys}</dt>
                    <dd className="gc-cheatsheet-effect">{r.effect}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
