import { config, type AccountKind } from "./config";

/**
 * Which Deriv account the app is pointed at right now.
 *
 * .env sets the starting value, but the settings modal can move between demo
 * and real without a rebuild, so the live choice lives here and the feed
 * reconnects whenever it changes.
 */
const KEY = "mrnyc.account-kind";

function read(): AccountKind {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "demo" || raw === "real") return raw;
  } catch {
    // Storage can be blocked in private windows; fall back to the env value.
  }
  return config.account;
}

let current: AccountKind = read();
const listeners = new Set<() => void>();

export function getAccountKind(): AccountKind {
  return current;
}

export function setAccountKind(kind: AccountKind): void {
  if (kind === current) return;
  current = kind;
  try {
    localStorage.setItem(KEY, kind);
  } catch {
    // Losing persistence is survivable; the session still switches.
  }
  for (const listener of listeners) listener();
}

export function subscribeAccountKind(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function accountCredentials(kind: AccountKind) {
  return config.accounts[kind];
}
