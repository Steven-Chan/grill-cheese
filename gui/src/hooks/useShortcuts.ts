import { useEffect } from "react";
import { useOverlay } from "../OverlayContext";

// Window-level keyboard bindings (ADR-0004 + amendment).
//   Cmd/Ctrl+K  → focus the chat composer (dispatch grill:focus-composer)
//   Cmd/Ctrl+B  → focus the branch listbox (dispatch grill:focus-branches)
//   Cmd/Ctrl+P  → open the command palette (preventDefault Print)
//   ?            → open the cheatsheet modal (when no textarea is focused)
//
// Palette + cheatsheet route through OverlayContext (ADR-0005): the App
// reads `active` and renders the matching overlay. Element-scoped bindings
// (Arrow / Space / Enter on the listbox, Cmd+Enter in textareas, layered
// Esc in the composer) live next to the elements themselves.

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export const FOCUS_COMPOSER_EVENT = "grill:focus-composer";
export const FOCUS_BRANCHES_EVENT = "grill:focus-branches";

export function useShortcuts() {
  const { setOverlay } = useOverlay();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Cmd/Ctrl+K — composer jump. Fires regardless of focus context.
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT));
        return;
      }
      // Cmd/Ctrl+B — branches jump. Fires from any context.
      if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(FOCUS_BRANCHES_EVENT));
        return;
      }
      // Cmd/Ctrl+P — command palette. preventDefault swallows browser Print
      // (app has no Print workflow; markdown export covers it).
      if ((e.metaKey || e.ctrlKey) && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        setOverlay("palette");
        return;
      }
      // ? — cheatsheet. Gated to non-text-input focus so literal `?` typing
      // in Own Answer / composer stays uninterrupted.
      if (e.key === "?" && !isTextInput(e.target)) {
        e.preventDefault();
        setOverlay("cheatsheet");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOverlay]);
}
