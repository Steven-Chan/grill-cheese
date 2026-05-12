import { Navigate, Route, Routes } from "react-router-dom";
import { CheatsheetModal } from "./components/CheatsheetModal";
import { useShortcuts } from "./hooks/useShortcuts";
import { useOverlay } from "./OverlayContext";
import { PerformancePage } from "./pages/PerformancePage";
import { SessionListPage } from "./pages/SessionListPage";
import { SessionDetailPage } from "./pages/SessionDetailPage";

export default function App() {
  // Window-level shortcuts mounted once at the root so Cmd+P / ? work on
  // every page (ADR-0004 amendment + ADR-0005).
  useShortcuts();
  const { active, setOverlay } = useOverlay();
  return (
    <>
      <Routes>
        <Route path="/" element={<Navigate to="/sessions" replace />} />
        <Route path="/sessions" element={<SessionListPage />} />
        <Route path="/sessions/:sid" element={<SessionDetailPage />} />
        <Route path="/performance" element={<PerformancePage />} />
        <Route path="*" element={<Navigate to="/sessions" replace />} />
      </Routes>
      {active === "cheatsheet" && <CheatsheetModal onClose={() => setOverlay(null)} />}
    </>
  );
}
