import {
  AUTH_FAIL_KEY,
  AUTH_LOCKOUT_KEY,
  AUTH_LOCKOUT_MS,
  MAX_AUTH_FAILURES,
} from "./constants";

interface FailRecord {
  count: number;
  lastAt: number;
}

interface LockoutRecord {
  until: number;
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
    // ignore
  }
}

function scopedKey(base: string, email: string): string {
  return `${email.trim().toLowerCase()}@${base}`;
}

export async function hashBackupCode(code: string): Promise<string> {
  const normalized = code.replace(/[\s-]/g, "").toUpperCase();
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function sessionFingerprint(): string {
  const raw = [
    navigator.userAgent,
    navigator.language,
    screen.colorDepth,
    screen.width,
    screen.height,
  ].join("|");
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash << 5) - hash + raw.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

export function createSessionToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function isAuthLocked(email: string): { locked: boolean; until: number | null } {
  const lock = readJson<LockoutRecord>(scopedKey(AUTH_LOCKOUT_KEY, email));
  if (!lock) return { locked: false, until: null };
  if (Date.now() >= lock.until) {
    localStorage.removeItem(scopedKey(AUTH_LOCKOUT_KEY, email));
    localStorage.removeItem(scopedKey(AUTH_FAIL_KEY, email));
    return { locked: false, until: null };
  }
  return { locked: true, until: lock.until };
}

export function recordAuthFailure(email: string): { locked: boolean; until: number | null } {
  const key = scopedKey(AUTH_FAIL_KEY, email);
  const prev = readJson<FailRecord>(key) ?? { count: 0, lastAt: 0 };
  const next: FailRecord = { count: prev.count + 1, lastAt: Date.now() };
  writeJson(key, next);

  if (next.count >= MAX_AUTH_FAILURES) {
    const until = Date.now() + AUTH_LOCKOUT_MS;
    writeJson(scopedKey(AUTH_LOCKOUT_KEY, email), { until });
    return { locked: true, until };
  }
  return { locked: false, until: null };
}

export function clearAuthFailures(email: string): void {
  localStorage.removeItem(scopedKey(AUTH_FAIL_KEY, email));
  localStorage.removeItem(scopedKey(AUTH_LOCKOUT_KEY, email));
}

export function lockoutMessage(until: number): string {
  const mins = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
}
