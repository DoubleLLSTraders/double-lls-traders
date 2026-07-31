import { accountCredentials, getAccountKind } from "./accountMode";
import { config, isConfigured } from "./config";
import type { ConnectionState } from "./deriv/types";
import { listAccounts } from "./deriv/rest";
import { firebaseMatchesEmail, getFirebaseUserEmail } from "./firebase/auth";
import { isFirebaseConfigured } from "./firebase/config";
import { fetchTotpRecord } from "./auth/totpRemote";
import { storageKey } from "./platform";

export type HealthLevel = "operational" | "degraded" | "down" | "unknown";

export interface HealthComponent {
  id: string;
  name: string;
  detail: string;
  level: HealthLevel;
  uptimePct: number;
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

interface HistoryStore {
  [componentId: string]: HealthLevel[];
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

function pushBar(componentId: string, level: HealthLevel): HealthLevel[] {
  const store = readHistory();
  const prev = store[componentId] ?? [];
  const next = [...prev, level];
  while (next.length > BAR_COUNT) next.shift();
  store[componentId] = next;
  writeHistory(store);
  return next;
}

function uptimeFromBars(bars: HealthLevel[]): number {
  if (bars.length === 0) return 100;
  const up = bars.filter((b) => b === "operational").length;
  return Math.round((up / bars.length) * 10000) / 100;
}

function fillBars(level: HealthLevel, bars: HealthLevel[]): HealthLevel[] {
  if (bars.length >= BAR_COUNT) return bars.slice(-BAR_COUNT);
  const pad = Array(BAR_COUNT - bars.length).fill(level) as HealthLevel[];
  return [...pad, ...bars];
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

export async function runPlatformHealthChecks(input: {
  feedState: ConnectionState;
  feedError: string | null;
  email: string | null;
}): Promise<PlatformHealthReport> {
  const checks: Array<{ id: string; name: string; detail: string; level: HealthLevel }> = [];

  checks.push({
    id: "deriv-feed",
    name: "Deriv live feed",
    detail: "OTP WebSocket tick stream",
    level: feedLevel(input.feedState, input.feedError),
  });

  let restLevel: HealthLevel = "unknown";
  try {
    const kind = getAccountKind();
    const token = accountCredentials(kind).token || config.token;
    if (!token) {
      restLevel = "down";
    } else {
      await listAccounts({ appId: config.appId, restUrl: config.restUrl, token });
      restLevel = "operational";
    }
  } catch {
    restLevel = "down";
  }
  checks.push({
    id: "deriv-rest",
    name: "Deriv REST API",
    detail: "Accounts, balance, and trade scope",
    level: restLevel,
  });

  const configLevel: HealthLevel = isConfigured ? "operational" : "down";
  checks.push({
    id: "platform-config",
    name: "Platform configuration",
    detail: "Deriv app ID and API tokens in .env",
    level: configLevel,
  });

  let authLevel: HealthLevel = "unknown";
  if (!isFirebaseConfigured()) {
    authLevel = "down";
  } else if (!input.email) {
    authLevel = "degraded";
  } else if (firebaseMatchesEmail(input.email) && getFirebaseUserEmail()) {
    authLevel = "operational";
  } else {
    authLevel = "down";
  }
  checks.push({
    id: "firebase-auth",
    name: "Firebase Auth",
    detail: "Google session bound to operator",
    level: authLevel,
  });

  let firestoreLevel: HealthLevel = "unknown";
  if (!input.email) {
    firestoreLevel = "degraded";
  } else {
    try {
      await fetchTotpRecord(input.email);
      firestoreLevel = "operational";
    } catch {
      firestoreLevel = "down";
    }
  }
  checks.push({
    id: "firestore-totp",
    name: "Firestore 2FA store",
    detail: "TOTP secrets and recovery hashes",
    level: firestoreLevel,
  });

  checks.push({
    id: "access-gate",
    name: "Access control",
    detail: "Google sign-in + Authenticator gate",
    level: input.email ? "operational" : "degraded",
  });

  const components: HealthComponent[] = checks.map((check) => {
    const bars = pushBar(check.id, check.level);
    return {
      ...check,
      uptimePct: uptimeFromBars(bars),
      bars: fillBars(check.level, bars),
    };
  });

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
      ? "All monitored services are responding normally on this device."
      : "Review the components below. Refresh after fixing configuration or connectivity.";

  return {
    overall,
    headline,
    subline,
    checkedAt: Date.now(),
    components,
  };
}
