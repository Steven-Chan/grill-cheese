import { useEffect } from "react";

// Window-level keyboard bindings (ADR-0004).
//   Cmd/Ctrl+K  → focus the chat composer (dispatch grill:focus-composer)
//   ?            → open the cheatsheet modal (when no textarea is focused)
//
// Element-scoped bindings (Arrow / Space / Enter on the listbox, Cmd+Enter
// in textareas, layered Esc in the composer) live next to the elements
// themselves — this hook only handles the global jumps.

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export const FOCUS_COMPOSER_EVENT = "grill:focus-composer";

export function useShortcuts({
  onOpenCheatsheet,
}: {
  onOpenCheatsheet: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Cmd/Ctrl+K — composer jump. Fires regardless of focus context so
      // the user can re-focus from anywhere on the page.
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT));
        return;
      }
      // ? — cheatsheet. Gated to non-text-input focus so literal `?` typing
      // in Own Answer / composer stays uninterrupted.
      if (e.key === "?" && !isTextInput(e.target)) {
        e.preventDefault();
        onOpenCheatsheet();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenCheatsheet]);
}
