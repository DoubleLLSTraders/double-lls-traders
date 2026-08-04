import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./components/AuthGate";
import { ClientShell } from "./ClientShell";
import { HubRoot } from "./HubRoot";
import { ThemeProvider } from "./hooks/useTheme";
import { getAppRole } from "./lib/appRole";
import { migrateLegacyStorage } from "./lib/platform";
import "./index.css";

migrateLegacyStorage();

const role = getAppRole();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      {role === "admin" ? (
        <AuthGate>
          <HubRoot />
        </AuthGate>
      ) : (
        <ClientShell />
      )}
    </ThemeProvider>
  </StrictMode>,
);
