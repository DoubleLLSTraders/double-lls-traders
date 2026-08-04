import { clearLiveAccess, hasLiveAccess } from "./auth/store";
import { isClientRole } from "./appRole";
import { config, type AccountKind } from "./config";
import { getSelectedOauthAccount } from "./deriv/oauth";
import { storageKey } from "./platform";

/**
 * Which Deriv account the app is pointed at right now.
 *
 * .env sets the starting value, but the settings modal can move between demo
 * and real without a rebuild. Live requires recent Authenticator verification.
 */
const KEY = storageKey("account-kind");
const LEGACY_KEY = "mrnyc.account-kind";

function migrateLegacyKey(): void {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy !== "demo" && legacy !== "real") return;
    if (localStorage.getItem(KEY) === null) {
      localStorage.setItem(KEY, legacy);
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // private mode
  }
}

function read(): AccountKind {
  migrateLegacyKey();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "demo" || raw === "real") return raw;
  } catch {
    // Storage can be blocked in private windows; fall back to the env value.
  }
  return config.account;
}

let current: AccountKind = read();

/** Real account without 2FA must not persist — force demo on load (admin only). */
if (current === "real" && !hasLiveAccess() && !isClientRole()) {
  current = "demo";
  try {
    localStorage.setItem(KEY, "demo");
  } catch {
    // ignore
  }
}

const listeners = new Set<() => void>();

export function getAccountKind(): AccountKind {
  if (isClientRole()) {
    const oauth = getSelectedOauthAccount();
    if (oauth) return oauth.kind;
  }
  if (current === "real" && !hasLiveAccess() && !isClientRole()) {
    return "demo";
  }
  return current;
}

export function setAccountKind(kind: AccountKind): boolean {
  if (kind === current) return true;

  // Client OAuth already proved possession of the Deriv account — no TOTP gate.
  if (kind === "real" && !hasLiveAccess() && !isClientRole()) {
    return false;
  }

  if (kind === "demo" && !isClientRole()) {
    clearLiveAccess();
  }

  current = kind;
  try {
    localStorage.setItem(KEY, kind);
  } catch {
    // Losing persistence is survivable; the session still switches.
  }
  for (const listener of listeners) listener();
  return true;
}

export function enforceLiveAccessPolicy(): void {
  if (current !== "real" || hasLiveAccess()) return;
  current = "demo";
  clearLiveAccess();
  try {
    localStorage.setItem(KEY, "demo");
  } catch {
    // ignore
  }
  for (const listener of listeners) listener();
}

export function subscribeAccountKind(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function accountCredentials(kind: AccountKind): {
  token: string;
  accountId: string;
  transport: "otp" | "oauth" | "public";
} {
  // Client desk: Deriv OAuth session wins over env PATs.
  if (isClientRole()) {
    const oauth = getSelectedOauthAccount();
    if (oauth) {
      return {
        token: oauth.token,
        accountId: oauth.loginid,
        transport: "oauth",
      };
    }
    // Visitor preview — public ticks only (no balance / buy).
    return { token: "", accountId: "", transport: "public" };
  }
  const base = config.accounts[kind];
  return { ...base, transport: "otp" as const };
}
