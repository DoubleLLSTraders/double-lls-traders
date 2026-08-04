/**
 * Deriv OAuth for client desk — login / create account on Deriv, then
 * authorize the classic WebSocket with the returned session token.
 *
 * Docs: https://developers.deriv.com/docs/oauth
 */

import { config } from "../config";
import { storageKey } from "../platform";
import type { AccountKind } from "../config";

const SESSION_KEY = storageKey("deriv-oauth-session");

export interface OauthAccount {
  loginid: string;
  token: string;
  currency: string;
  /** VRTC / VRW / VR… → demo; CR… → live. */
  kind: AccountKind;
}

export interface OauthSession {
  accounts: OauthAccount[];
  selectedLoginid: string | null;
  updatedAt: number;
}

const listeners = new Set<() => void>();

function isVirtualLoginid(loginid: string): boolean {
  const id = loginid.toUpperCase();
  return id.startsWith("VR") || id.startsWith("VRT") || id.includes("VRTC");
}

function kindForLoginid(loginid: string): AccountKind {
  return isVirtualLoginid(loginid) ? "demo" : "real";
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeOauthSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readOauthSession(): OauthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OauthSession;
    if (!parsed?.accounts?.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeOauthSession(session: OauthSession | null): void {
  try {
    if (!session) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // private mode
  }
  notify();
}

export function clearOauthSession(): void {
  writeOauthSession(null);
}

export function getSelectedOauthAccount(): OauthAccount | null {
  const session = readOauthSession();
  if (!session) return null;
  const id = session.selectedLoginid;
  if (id) {
    const hit = session.accounts.find((a) => a.loginid === id);
    if (hit) return hit;
  }
  return session.accounts[0] ?? null;
}

export function selectOauthAccount(loginid: string): boolean {
  const session = readOauthSession();
  if (!session) return false;
  if (!session.accounts.some((a) => a.loginid === loginid)) return false;
  writeOauthSession({ ...session, selectedLoginid: loginid, updatedAt: Date.now() });
  return true;
}

/** Build Deriv OAuth authorize URL (login + create account both land here). */
export function derivOauthAuthorizeUrl(options?: {
  /** Optional branding / affiliate. */
  affiliateToken?: string;
}): string {
  const appId = config.appId;
  const url = new URL("https://oauth.deriv.com/oauth2/authorize");
  url.searchParams.set("app_id", appId);
  if (options?.affiliateToken) {
    url.searchParams.set("affiliate_token", options.affiliateToken);
  }
  return url.toString();
}

/**
 * Parse acctN/tokenN/curN from the OAuth redirect query (or hash).
 */
export function parseOauthRedirectParams(
  search: string,
  hash = "",
): OauthAccount[] {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (hash.includes("acct1=") || hash.includes("token1=")) {
    const h = hash.startsWith("#") ? hash.slice(1) : hash;
    const fromHash = new URLSearchParams(h.includes("=") ? h : h.replace(/^\/?/, ""));
    for (const [k, v] of fromHash) {
      if (!params.has(k)) params.set(k, v);
    }
  }

  const accounts: OauthAccount[] = [];
  for (let i = 1; i <= 20; i += 1) {
    const loginid = params.get(`acct${i}`)?.trim();
    const token = params.get(`token${i}`)?.trim();
    if (!loginid || !token) continue;
    const currency = (params.get(`cur${i}`) ?? "USD").trim().toUpperCase();
    accounts.push({
      loginid,
      token,
      currency,
      kind: kindForLoginid(loginid),
    });
  }
  return accounts;
}

/** True when the current URL still carries OAuth return params. */
export function urlHasOauthReturn(loc: Location = window.location): boolean {
  return parseOauthRedirectParams(loc.search, loc.hash).length > 0;
}

/**
 * Consume OAuth return params into session storage and strip them from the URL.
 */
export function consumeOauthRedirect(loc: Location = window.location): OauthSession | null {
  const accounts = parseOauthRedirectParams(loc.search, loc.hash);
  if (!accounts.length) return null;

  const preferDemo = accounts.find((a) => a.kind === "demo") ?? accounts[0]!;
  const session: OauthSession = {
    accounts,
    selectedLoginid: preferDemo.loginid,
    updatedAt: Date.now(),
  };
  writeOauthSession(session);

  try {
    const url = new URL(loc.href);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(acct|token|cur)\d+$/i.test(key) || key === "state") {
        url.searchParams.delete(key);
      }
    }
    if (url.hash && /acct\d=/i.test(url.hash)) url.hash = "";
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  } catch {
    // ignore
  }

  return session;
}

export function hasOauthSession(): boolean {
  return getSelectedOauthAccount() !== null;
}
