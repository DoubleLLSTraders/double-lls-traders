import { useEffect, useState } from "react";
import type { CloudStatus, CloudTrade } from "../server/cloudBots";
import type { BotSettings } from "./bot";
import { HISTORY_EVENT, loadHistory, loadSettings, mergeHistory, replaceSettings, SETTINGS_EVENT, type SessionRecord } from "./sessionStore";
import { ACCOUNT_KEY, LICENCE_EVENT, loadLicence, saveLicence } from "./siteClient";

const SYNC_KEY = "double-lls:account-sync:v1";
export const ACCOUNT_EVENT = "double-lls:account";
const PUSH_DELAY_MS = 4000;
const BATCH = 5;

export interface Account {
  token: string;
  email: string;
  name: string;
  createdAt: number;
  emailVerified?: boolean;
}

export interface AccountLicence {
  licence: string;
  plan: string;
  email: string;
  version: string;
  addedAt: number;
}

interface AccountData {
  token?: string;
  account: { email: string; name: string; createdAt: number; emailVerified?: boolean };
  settings: Partial<BotSettings> | null;
  settingsAt: number;
  licences: AccountLicence[];
  sessions: SessionRecord[];
}

/** What this device has already sent to the account, so only changes are uploaded. */
interface SyncState {
  email: string;
  sessions: Record<string, number>;
  settingsAt: number;
  settingsJson: string;
  licences: AccountLicence[];
}

export type SyncStatus = "idle" | "saving" | "saved" | "error";

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked */
  }
}

export const loadAccount = () => read<Account>(ACCOUNT_KEY);

function syncState(email: string): SyncState {
  const s = read<SyncState>(SYNC_KEY);
  return s && s.email === email ? s : { email, sessions: {}, settingsAt: 0, settingsJson: "", licences: [] };
}

let status: SyncStatus = "idle";
let savedAt = 0;
const statusListeners = new Set<() => void>();
function setStatus(next: SyncStatus) {
  status = next;
  if (next === "saved") savedAt = Date.now();
  statusListeners.forEach((fn) => fn());
}

/** The signed-in account on this device, kept in sync across components. */
export function useAccount(): Account | null {
  const [account, setAccount] = useState(loadAccount);
  useEffect(() => {
    const sync = () => setAccount(loadAccount());
    window.addEventListener(ACCOUNT_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(ACCOUNT_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return account;
}

export function useSyncStatus() {
  const [state, setState] = useState({ status, savedAt });
  useEffect(() => {
    const fn = () => setState({ status, savedAt });
    statusListeners.add(fn);
    return () => void statusListeners.delete(fn);
  }, []);
  return state;
}

function setAccount(account: Account | null) {
  write(ACCOUNT_KEY, account);
  window.dispatchEvent(new Event(ACCOUNT_EVENT));
}

async function request<T>(method: string, path: string, body?: unknown, token = loadAccount()?.token): Promise<T> {
  const res = await fetch(`/api/account${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) setAccount(null);
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status}).`);
  return data as T;
}

/** Brings this device and the account together: newer sessions and settings win on each side. */
function applyRemote(data: AccountData) {
  const sync = syncState(data.account.email);
  for (const r of data.sessions) sync.sessions[r.id] = Math.max(sync.sessions[r.id] ?? 0, r.updatedAt);
  if (data.sessions.length) mergeHistory(data.sessions);
  if (data.settings && data.settingsAt > sync.settingsAt) {
    replaceSettings(data.settings);
    sync.settingsAt = data.settingsAt;
    sync.settingsJson = JSON.stringify(loadSettings());
  }
  sync.licences = data.licences;
  write(SYNC_KEY, sync);
  const local = loadLicence();
  if (!local && data.licences.length) {
    const l = data.licences[data.licences.length - 1];
    saveLicence({ licence: l.licence, plan: l.plan, email: l.email, version: l.version });
  }
  void push();
}

async function signedIn(data: AccountData) {
  setAccount({
    token: data.token!,
    email: data.account.email,
    name: data.account.name,
    createdAt: data.account.createdAt,
    emailVerified: data.account.emailVerified === true,
  });
  applyRemote(data);
}

const firebase = () => import("./firebase");

/** Runs a Firebase step and rethrows its error as a plain sentence. */
async function fb<T>(step: (m: typeof import("./firebase")) => Promise<T>): Promise<T> {
  const m = await firebase();
  try {
    return await step(m);
  } catch (err) {
    throw Object.assign(new Error(m.friendly(err)), { code: m.authCode(err) });
  }
}

const exchange = (idToken: string, extra: { name?: string; acceptTerms?: boolean } = {}) =>
  request<AccountData>("POST", "/firebase", { idToken, ...extra }, undefined);

/** Creates the Firebase user (which emails a verification link), then the site account. */
export async function signUp(input: { email: string; password: string; name: string; acceptTerms: boolean }) {
  const idToken = await fb((m) => m.firebaseAdopt(input.email, input.password));
  await signedIn(await exchange(idToken, { name: input.name, acceptTerms: input.acceptTerms }));
}

export async function signIn(email: string, password: string) {
  let idToken: string;
  try {
    idToken = await fb((m) => m.firebaseSignIn(email, password));
  } catch (err) {
    if (!["auth/invalid-credential", "auth/user-not-found", "auth/wrong-password"].includes((err as { code?: string }).code ?? "")) throw err;
    // Accounts made before Firebase sign-in still have the old site password: check it, then move them over.
    const legacy = await request<AccountData>("POST", "/login", { email, password }, undefined);
    try {
      idToken = await fb((m) => m.firebaseAdopt(email, password));
    } catch {
      await signedIn(legacy);
      return;
    }
  }
  await signedIn(await exchange(idToken));
}

export async function signOut() {
  await request("POST", "/logout").catch(() => {});
  await (await firebase()).firebaseSignOut();
  setAccount(null);
  setStatus("idle");
}

/** Emails a password reset link. Says nothing about whether the email has an account. */
export const sendPasswordReset = (email: string) => fb((m) => m.sendReset(email.trim()));

export const resendVerification = () => fb((m) => m.resendVerification());

/** Firebase-only check; once it says yes, call refreshVerification to record it on the account. */
export const emailVerifiedYet = () => fb((m) => m.isEmailVerified());

/** Re-reads the email-verified flag from Firebase and stores it on the account. */
export async function refreshVerification() {
  const account = loadAccount();
  if (!account) return false;
  const fresh = await fb((m) => m.freshIdToken());
  if (!fresh) return account.emailVerified === true;
  const data = await request<AccountData>("PUT", "/verification", { idToken: fresh.token });
  setAccount({ ...account, emailVerified: data.account.emailVerified === true });
  return data.account.emailVerified === true;
}

export async function changePassword(current: string, next: string) {
  const account = loadAccount();
  if (!account) throw new Error("Please sign in again.");
  try {
    await fb((m) => m.changePassword(account.email, current, next));
  } catch (err) {
    if (!["auth/invalid-credential", "auth/user-not-found"].includes((err as { code?: string }).code ?? "")) throw err;
    // Not moved to Firebase yet: the old site password must match before the account is moved with the new one.
    await request("POST", "/login", { email: account.email, password: current }, undefined);
    const idToken = await fb(async (m) => {
      await m.firebaseAdopt(account.email, current);
      await m.changePassword(account.email, current, next);
      return (await m.freshIdToken())?.token ?? "";
    });
    if (idToken) await request("PUT", "/verification", { idToken });
  }
}

export async function deleteAccount(password: string) {
  const account = loadAccount();
  if (account) {
    try {
      await fb((m) => m.firebaseDelete(account.email, password));
    } catch (err) {
      if (!["auth/invalid-credential", "auth/user-not-found"].includes((err as { code?: string }).code ?? "")) throw err;
      // No Firebase user yet: the old site password has to match instead.
      await request("POST", "/login", { email: account.email, password }, undefined);
    }
  }
  await request("DELETE", "/");
  write(SYNC_KEY, null);
  write(API_KEY_STORE, null);
  setAccount(null);
  setStatus("idle");
}

export async function refreshAccount() {
  if (!loadAccount()) return null;
  const data = await request<AccountData>("GET", "/");
  applyRemote(data);
  return data;
}

export interface ApiKeyInfo {
  id: string;
  prefix: string;
  name: string;
  createdAt: string;
  lastUsed: string;
  requests: number;
}

export const API_KEY_STORE = "lls-api-key";

async function keysRequest<T>(method: string, path = "", body?: unknown): Promise<T> {
  const token = loadAccount()?.token;
  const res = await fetch(`/api/v1/keys${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) setAccount(null);
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status}).`);
  return data as T;
}

export const listApiKeys = async () => (await keysRequest<{ keys: ApiKeyInfo[] }>("GET")).keys;

/** Creates a key; the full key is in the result once and is also kept on this device for the docs examples. */
export async function createApiKey(name: string) {
  const created = await keysRequest<ApiKeyInfo & { key: string }>("POST", "", { name });
  write(API_KEY_STORE, created.key);
  return created;
}

export async function revokeApiKey(key: ApiKeyInfo) {
  await keysRequest("DELETE", `/${key.id}`);
  if (savedApiKey().startsWith(key.prefix)) write(API_KEY_STORE, null);
}

/** The most recent key created on this device, for filling in examples. */
export const savedApiKey = () => read<string>(API_KEY_STORE) ?? "";

let pushing = false;
let again = false;

/** Uploads whatever changed on this device since the last sync. */
async function push() {
  const account = loadAccount();
  if (!account) return;
  if (pushing) {
    again = true;
    return;
  }
  pushing = true;
  const sync = syncState(account.email);
  try {
    const changed = loadHistory().filter((r) => (sync.sessions[r.id] ?? 0) < r.updatedAt);
    const settingsJson = JSON.stringify(loadSettings());
    const licence = loadLicence();
    const newLicence = licence && !sync.licences.some((l) => l.licence === licence.licence && l.version === licence.version) ? licence : null;
    if (!changed.length && settingsJson === sync.settingsJson && !newLicence) return;
    setStatus("saving");
    for (let i = 0; i < changed.length; i += BATCH) {
      const batch = changed.slice(i, i + BATCH);
      await request("PUT", "/sessions", { sessions: batch });
      for (const r of batch) sync.sessions[r.id] = r.updatedAt;
      write(SYNC_KEY, sync);
    }
    if (settingsJson !== sync.settingsJson) {
      const res = await request<{ settingsAt: number }>("PUT", "/settings", { settings: JSON.parse(settingsJson) });
      sync.settingsAt = res.settingsAt;
      sync.settingsJson = settingsJson;
    }
    if (newLicence) {
      const res = await request<{ licences: AccountLicence[] }>("POST", "/licences", { licence: newLicence.licence, version: newLicence.version });
      sync.licences = res.licences;
    }
    write(SYNC_KEY, sync);
    setStatus("saved");
  } catch {
    if (loadAccount()) setStatus("error");
  } finally {
    pushing = false;
    if (again) {
      again = false;
      void push();
    }
  }
}

export const syncNow = push;

export interface CloudBotView {
  configured: boolean;
  enabled?: boolean;
  settings?: BotSettings;
  allowReal?: boolean;
  updatedAt?: number;
  hasToken?: boolean;
  status?: CloudStatus | null;
  recent?: CloudTrade[];
}

export const getCloudBot = () => request<CloudBotView>("GET", "/cloud-bot");
export const saveCloudBot = (body: { enabled: boolean; derivToken?: string; settings?: BotSettings; allowReal?: boolean }) =>
  request<CloudBotView>("PUT", "/cloud-bot", body);
export const removeCloudBot = () => request<CloudBotView>("DELETE", "/cloud-bot");

/** Keeps the signed-in account up to date with this device. Returns a cleanup function. */
export function startAccountSync() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (!loadAccount() || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void push();
    }, PUSH_DELAY_MS);
  };
  const flush = () => {
    if (document.visibilityState === "hidden") void push();
  };
  const events = [HISTORY_EVENT, SETTINGS_EVENT, LICENCE_EVENT];
  events.forEach((e) => window.addEventListener(e, schedule));
  document.addEventListener("visibilitychange", flush);
  void refreshAccount().catch(() => {});
  return () => {
    if (timer) clearTimeout(timer);
    events.forEach((e) => window.removeEventListener(e, schedule));
    document.removeEventListener("visibilitychange", flush);
  };
}
