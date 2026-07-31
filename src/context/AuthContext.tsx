import { createContext, useContext, type ReactNode } from "react";
import { useAppAuthState, type AppAuth } from "../hooks/useAppAuth";

const AuthContext = createContext<AppAuth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useAppAuthState();
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

export function useAppAuth(): AppAuth {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAppAuth must be used inside AuthProvider.");
  return ctx;
}
