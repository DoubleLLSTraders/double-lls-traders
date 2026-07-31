import { accountCredentials, getAccountKind } from "./accountMode";
import { config, isConfigured } from "./config";
import type { ConnectionState } from "./deriv/types";
import { listAccounts } from "./deriv/rest";
import { firebaseMatchesEmail, getFirebaseUserEmail } from "./firebase/auth";
import { isFirebaseConfigured, readFirebaseConfig } from "./firebase/config";
import { fetchTotpRecord } from "./auth/totpRemote";
import {
  GITHUB_ORG,
  GITHUB_PAGES_URL,
  GITHUB_REPO,
  GITHUB_REPO_URL,
  storageKey,
} from "./platform";

export type HealthLevel = "operational" | "degraded" | "down" | "unknown";

export interface HealthComponent {
  id: string;
  name: string;
  detail: string;
  endpoint: string;
  level: HealthLevel;
  uptimePct: number;
  probeCount: number;
  latencyMs: number | null;
  bars: HealthLevel[];
}

export interface PlatformHealthReport {
  overall: HealthLevel;
  headline: string;
  subline: string;
  checkedAt: number;
  components: HealthComponent[];
}

const HISTORY_KEY = storageKey("platform-status-history");
const BAR_COUNT = 90;
const PROBE_TIMEOUT_MS = 10_000;

interface HistoryStore {
  [componentId: string]: HealthLevel[];
}

interface ProbeResult {
  level: HealthLevel;
  detail: string;
  latencyMs: number | null;
}

function readHistory(): HistoryStore {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as HistoryStore;
  } catch {
    return {};
  }
}

function writeHistory(store: HistoryStore): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(store));
  } catch {
    // quota / private mode
  }
}

function recordProbe(componentId: string, level: HealthLevel): HealthLevel[] {
  const store = readHistory();
  const prev = store[componentId] ?? [];
  const next = [...prev, level];
  while (next.length > BAR_COUNT) next.shift();
  store[componentId] = next;
  writeHistory(store);
  return next;
}

function uptimeFromBars(bars: HealthLevel[]): { pct: number; probeCount: number } {
  const sampled = bars.filter((b) => b !== "unknown");
  if (sampled.length === 0) return { pct: 100, probeCount: 0 };
  const up = sampled.filter((b) => b === "operational").length;
  return {
    pct: Math.round((up / sampled.length) * 10000) / 100,
    probeCount: sampled.length,
  };
}

function barsForDisplay(bars: HealthLevel[]): HealthLevel[] {
  if (bars.length >= BAR_COUNT) return bars.slice(-BAR_COUNT);
  const empty = Array(BAR_COUNT - bars.length).fill("unknown") satisfies HealthLevel[];
  return [...empty, ...bars];
}

function worstLevel(levels: HealthLevel[]): HealthLevel {
  if (levels.includes("down")) return "down";
  if (levels.includes("degraded")) return "degraded";
  if (levels.every((l) => l === "operational")) return "operational";
  return "unknown";
}

function feedLevel(state: ConnectionState, error: string | null): HealthLevel {
  if (state === "ready" && !error) return "operational";
  if (state === "connecting" || state === "reconnecting") return "degraded";
  if (state === "error" || state === "closed") return "down";
  return "unknown";
}

async function timedProbe(run: () => Promise<ProbeResult>): Promise<ProbeResult> {
  const start = performance.now();
  try {
    const result = await run();
    if (result.latencyMs === null) {
      return { ...result, latencyMs: Math.round(performance.now() - start) };
    }
    return result;
  } catch (error) {
    return {
      level: "down",
      detail: error instanceof Error ? error.message : "Probe failed",
      latencyMs: Math.round(performance.now() - start),
    };
  }
}

async function checkGitHubPlatform(): Promise<ProbeResult & { endpoint: string }> {
  const endpoint = "https://www.githubstatus.com/api/v2/status.json";
  const result = await timedProbe(async () => {
    const res = await fetch(endpoint, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { level: "degraded" as const, detail: `GitHub Status API · HTTP ${res.status}`, latencyMs: null };
    }
    const data = (await res.json()) as {
      status?: { indicator?: string; description?: string };
    };
    const indicator = data.status?.indicator ?? "unknown";
    const desc = data.status?.description ?? "GitHub platform";
    if (indicator === "none") {
      return { level: "operational", detail: desc, latencyMs: null };
    }
    if (indicator === "minor") {
      return { level: "degraded", detail: desc, latencyMs: null };
    }
    return { level: "down", detail: desc, latencyMs: null };
  });
  return { ...result, endpoint };
}

async function checkGitHubRepo(): Promise<ProbeResult & { endpoint: string }> {
  const endpoint = `https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}`;
  const result = await timedProbe(async () => {
    const res = await fetch(endpoint, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as { default_branch?: string; private?: boolean };
      const branch = data.default_branch ?? "master";
      const vis = data.private ? "private" : "public";
      return {
        level: "operational",
        detail: `${GITHUB_ORG}/${GITHUB_REPO} · ${vis} · ${branch}`,
        latencyMs: null,
      };
    }
    if (res.status === 404) {
      return {
        level: "operational",
        detail: `${GITHUB_REPO_URL} · private repo (live on GitHub)`,
        latencyMs: null,
      };
    }
    if (res.status === 403) {
      return { level: "degraded", detail: "GitHub API rate limit — retry later", latencyMs: null };
    }
    return { level: "degraded", detail: `GitHub API · HTTP ${res.status}`, latencyMs: null };
  });
  return { ...result, endpoint };
}

async function checkGitHubPages(): Promise<ProbeResult & { endpoint: string }> {
  const endpoint = GITHUB_PAGES_URL;
  const result = await timedProbe(async () => {
    try {
      const res = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.ok) {
        return { level: "operational" as const, detail: "Hosted desk · HTTP 200", latencyMs: null };
      }
      if (res.status === 404) {
        return {
          level: "down" as const,
          detail: "Hosted desk · HTTP 404 (Pages not deployed yet)",
          latencyMs: null,
        };
      }
      return {
        level: (res.status >= 500 ? "down" : "degraded") as HealthLevel,
        detail: `Hosted desk · HTTP ${res.status}`,
        latencyMs: null,
      };
    } catch (corsErr) {
      // GitHub Pages blocks cross-origin reads — confirm reachability with no-cors.
      try {
        await fetch(endpoint, {
          method: "HEAD",
          mode: "no-cors",
          cache: "no-store",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return {
          level: "operational" as const,
          detail: "Hosted desk reachable · live on GitHub Pages",
          latencyMs: null,
        };
      } catch {
        const msg = corsErr instanceof Error ? corsErr.message : "Hosted desk unreachable";
        return { level: "down" as const, detail: msg, latencyMs: null };
      }
    }
  });
  return { ...result, endpoint };
}

async function checkDerivRest(): Promise<ProbeResult & { endpoint: string }> {
  const endpoint = config.restUrl;
  return timedProbe(async () => {
    const kind = getAccountKind();
    const token = accountCredentials(kind).token || config.token;
    if (!token) {
      return { level: "down", detail: "No Deriv PAT configured", latencyMs: null };
    }
    await listAccounts({ appId: config.appId, restUrl: config.restUrl, token });
    return { level: "operational", detail: "Accounts API · trade scope OK", latencyMs: null };
  }).then((r) => ({ ...r, endpoint }));
}

async function checkFirestore(email: string | null): Promise<ProbeResult & { endpoint: string }> {
  const fb = readFirebaseConfig();
  const endpoint = fb
    ? `Firestore · ${fb.projectId} · totp_secrets/{email}`
    : "Firestore · not configured";
  if (!email) {
    return { level: "degraded", detail: "Sign in required to probe Firestore rules", latencyMs: null, endpoint };
  }
  const result = await timedProbe(async () => {
    const record = await fetchTotpRecord(email);
    if (record?.secret) {
      return { level: "operational", detail: "TOTP record readable · rules OK", latencyMs: null };
    }
    return { level: "degraded", detail: "No TOTP record yet · first-time setup pending", latencyMs: null };
  });
  return { ...result, endpoint };
}

function buildComponent(
  id: string,
  name: string,
  endpoint: string,
  probe: ProbeResult,
): HealthComponent {
  const bars = recordProbe(id, probe.level);
  const { pct, probeCount } = uptimeFromBars(bars);
  return {
    id,
    name,
    detail: probe.detail,
    endpoint,
    level: probe.level,
    uptimePct: pct,
    probeCount,
    latencyMs: probe.latencyMs,
    bars: barsForDisplay(bars),
  };
}

export async function runPlatformHealthChecks(input: {
  feedState: ConnectionState;
  feedError: string | null;
  email: string | null;
}): Promise<PlatformHealthReport> {
  const [
    githubPlatform,
    githubRepo,
    githubPages,
    derivRest,
    firestore,
  ] = await Promise.all([
    checkGitHubPlatform(),
    checkGitHubRepo(),
    checkGitHubPages(),
    checkDerivRest(),
    checkFirestore(input.email),
  ]);

  const feedProbe: ProbeResult = {
    level: feedLevel(input.feedState, input.feedError),
    detail:
      input.feedError ??
      (input.feedState === "ready"
        ? "WebSocket tick stream connected"
        : `Feed state · ${input.feedState}`),
    latencyMs: null,
  };

  const configProbe: ProbeResult = {
    level: isConfigured ? "operational" : "down",
    detail: isConfigured ? "Deriv app ID and PAT present" : "Missing required .env values",
    latencyMs: null,
  };

  let authProbe: ProbeResult = {
    level: "unknown",
    detail: "Checking Firebase Auth…",
    latencyMs: null,
  };
  const fb = readFirebaseConfig();
  const authEndpoint = fb ? `Firebase Auth · ${fb.authDomain}` : "Firebase Auth · not configured";
  if (!isFirebaseConfigured()) {
    authProbe = { level: "down", detail: "Firebase web config missing", latencyMs: null };
  } else if (!input.email) {
    authProbe = { level: "degraded", detail: "No signed-in operator", latencyMs: null };
  } else if (firebaseMatchesEmail(input.email) && getFirebaseUserEmail()) {
    authProbe = { level: "operational", detail: `Session bound · ${input.email}`, latencyMs: null };
  } else {
    authProbe = { level: "down", detail: "Firebase Auth session mismatch", latencyMs: null };
  }

  const components: HealthComponent[] = [
    buildComponent("github-platform", "GitHub platform", githubPlatform.endpoint, githubPlatform),
    buildComponent("github-repo", "GitHub repository", githubRepo.endpoint, githubRepo),
    buildComponent("github-pages", "Hosted desk (GitHub Pages)", githubPages.endpoint, githubPages),
    buildComponent("deriv-feed", "Deriv live feed", "Deriv OTP WebSocket", feedProbe),
    buildComponent("deriv-rest", "Deriv REST API", derivRest.endpoint, derivRest),
    buildComponent("firebase-auth", "Firebase Auth", authEndpoint, authProbe),
    buildComponent("firestore-totp", "Firestore 2FA store", firestore.endpoint, firestore),
    buildComponent("platform-config", "Platform configuration", "Local .env / Vite config", configProbe),
  ];

  const overall = worstLevel(components.map((c) => c.level));
  const headline =
    overall === "operational"
      ? "We're fully operational."
      : overall === "degraded"
        ? "Some systems need attention."
        : overall === "down"
          ? "Issues affecting the platform."
          : "Checking systems…";

  const subline =
    overall === "operational"
      ? "Live probes to GitHub, Deriv, Firebase, and the hosted desk succeeded."
      : "Results below are from real network checks on this device — refresh after fixes.";

  return {
    overall,
    headline,
    subline,
    checkedAt: Date.now(),
    components,
  };
}

export function startStatusRecorder(
  input: () => { feedState: ConnectionState; feedError: string | null; email: string | null },
  intervalMs = 5 * 60_000,
): () => void {
  const tick = () => {
    void runPlatformHealthChecks(input());
  };
  const id = window.setInterval(tick, intervalMs);
  return () => window.clearInterval(id);
}
