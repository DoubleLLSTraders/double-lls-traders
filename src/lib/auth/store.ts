import { AUTH_SESSION_KEY, SESSION_TTL_MS } from "./constants";
import { createSessionToken, sessionFingerprint } from "./security";

/** How long demo→live access lasts after Authenticator verification. */
export const LIVE_ACCESS_TTL_MS = 30 * 60 * 1000;

export interface AuthSession {
  email: string;
  name: string;
  picture?: string;
  verifiedAt: number;
  expiresAt: number;
  /** Random per-session id — invalidated on sign-out. */
  token: string;
  /** Browser fingerprint at sign-in — blocks simple session copy. */
  fingerprint: string;
  /** Set after Authenticator confirms a switch to Live trading. */
  liveVerifiedAt?: number;
}

/** Stored in Firebase — kept here for typing only. */
export interface TotpRecord {
  secret: string;
  setupAt: number;
  backupCodeHashes?: string[];
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota — auth falls back to prompting again.
  }
}

export function readSession(): AuthSession | null {
  const session = readJson<AuthSession>(AUTH_SESSION_KEY);
  if (!session) return null;
  if (Date.now() >= session.expiresAt) {
    clearSession();
    return null;
  }
  if (session.fingerprint && session.fingerprint !== sessionFingerprint()) {
    clearSession();
    return null;
  }
  return session;
}

export function writeSession(profile: Pick<AuthSession, "email" | "name" | "picture">): AuthSession {
  const now = Date.now();
  const session: AuthSession = {
    ...profile,
    verifiedAt: now,
    expiresAt: now + SESSION_TTL_MS,
    token: createSessionToken(),
    fingerprint: sessionFingerprint(),
  };
  writeJson(AUTH_SESSION_KEY, session);
  return session;
}

export function clearSession(): void {
  try {
    localStorage.removeItem(AUTH_SESSION_KEY);
  } catch {
    // ignore
  }
}

export function grantLiveAccess(): AuthSession | null {
  const session = readSession();
  if (!session) return null;
  const next: AuthSession = { ...session, liveVerifiedAt: Date.now() };
  writeJson(AUTH_SESSION_KEY, next);
  return next;
}

export function hasLiveAccess(): boolean {
  const session = readSession();
  if (!session?.liveVerifiedAt) return false;
  return Date.now() < session.liveVerifiedAt + LIVE_ACCESS_TTL_MS;
}

export function clearLiveAccess(): void {
  const session = readSession();
  if (!session?.liveVerifiedAt) return;
  const { liveVerifiedAt: _removed, ...rest } = session;
  writeJson(AUTH_SESSION_KEY, rest);
}
