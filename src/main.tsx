import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GoogleOAuthProvider } from "@react-oauth/google";
import App from "./App.tsx";
import { AuthGate } from "./components/AuthGate";
import { ThemeProvider } from "./hooks/useTheme";
import { googleClientId } from "./lib/auth/google";
import { migrateLegacyStorage } from "./lib/platform";
import "./index.css";

migrateLegacyStorage();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <GoogleOAuthProvider clientId={googleClientId()}>
        <AuthGate>
          <App />
        </AuthGate>
      </GoogleOAuthProvider>
    </ThemeProvider>
  </StrictMode>,
);
