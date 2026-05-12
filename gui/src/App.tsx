import { Navigate, Route, Routes } from "react-router-dom";
import { PerformancePage } from "./pages/PerformancePage";
import { SessionListPage } from "./pages/SessionListPage";
import { SessionDetailPage } from "./pages/SessionDetailPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/sessions" replace />} />
      <Route path="/sessions" element={<SessionListPage />} />
      <Route path="/sessions/:sid" element={<SessionDetailPage />} />
      <Route path="/performance" element={<PerformancePage />} />
      <Route path="*" element={<Navigate to="/sessions" replace />} />
    </Routes>
  );
}
