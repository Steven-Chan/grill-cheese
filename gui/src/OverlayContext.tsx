import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

// Modal-exclusive overlay coordinator (ADR-0005). At most one full-screen
// overlay visible at a time. Opening any overlay dismisses the prior.
//
// In-flow surfaces (DecisionMap inside summary card, SidebarHistory,
// composer @-popup) are out of scope.

export type OverlayId = "palette" | "cheatsheet" | null;

interface OverlayContextValue {
  active: OverlayId;
  setOverlay: (next: OverlayId) => void;
}

const Ctx = createContext<OverlayContextValue | null>(null);

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<OverlayId>(null);
  const setOverlay = useCallback((next: OverlayId) => setActive(next), []);
  return <Ctx.Provider value={{ active, setOverlay }}>{children}</Ctx.Provider>;
}

export function useOverlay(): OverlayContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOverlay outside <OverlayProvider>");
  return v;
}
