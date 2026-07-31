import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { AuthGate } from "./components/AuthGate";
import { ThemeProvider } from "./hooks/useTheme";
import { migrateLegacyStorage } from "./lib/platform";
import "./index.css";

migrateLegacyStorage();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </ThemeProvider>
  </StrictMode>,
);
