import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AppProvider } from "./AppContext";
import { OverlayProvider } from "./OverlayContext";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
        <OverlayProvider>
          <App />
        </OverlayProvider>
      </AppProvider>
    </BrowserRouter>
  </StrictMode>
);
