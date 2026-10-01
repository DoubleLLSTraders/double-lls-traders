import type { Firestore } from "firebase-admin/firestore";
import type { BotSettings } from "../src/bot";

/** Firestore collection shared by the site (control fields) and the Cloud Run worker (status fields). */
export const CLOUD_BOTS = "cloudBots";
export const CLOUD_RECENT_TRADES = 50;

export type CloudState = "starting" | "running" | "stopped" | "error";

export interface CloudTrade {
  id: number;
  at: number;
  market: string;
  label: string;
  stake: number;
  pnl: number;
  won: boolean;
  digit: number;
  reason: string;
}

export interface CloudStatus {
  state: CloudState;
  message: string;
  loginid: string;
  isVirtual: boolean;
  currency: string;
  startBalance: number;
  balance: number;
  pnl: number;
  dayPnl: number;
  trades: number;
  wins: number;
  maxDrawdown: number;
  open: string | null;
  startedAt: number;
  heartbeat: number;
}

/** One document per account, id = account id. The site writes the control fields; the worker writes status and recent. */
export interface CloudBotDoc {
  enabled: boolean;
  settings: BotSettings;
  /** Deriv API token, AES-GCM sealed with CLOUD_BOT_KEY. Never sent to browsers. */
  tokenEnc: string;
  allowReal: boolean;
  email: string;
  licence: string;
  /** Bumped on every change from the site; the worker restarts the bot when it moves. */
  updatedAt: number;
  status?: CloudStatus;
  recent?: CloudTrade[];
}

let db: Promise<Firestore | null> | null = null;

/**
 * Firestore through firebase-admin. On Google Cloud the runtime's own identity is used;
 * elsewhere (Netlify, local) FIREBASE_SERVICE_ACCOUNT holds the service-account JSON, raw or base64.
 * Resolves to null when neither is available.
 */
export function cloudDb(env: Record<string, string | undefined>): Promise<Firestore | null> {
  db ??= (async () => {
    const raw = (env.FIREBASE_SERVICE_ACCOUNT ?? "").trim();
    const onGoogle = !!(env.K_SERVICE || env.CLOUD_RUN_WORKER_POOL || env.GOOGLE_APPLICATION_CREDENTIALS);
    if (!raw && !onGoogle) return null;
    const { initializeApp, getApps, cert } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    if (!getApps().length) {
      if (raw) {
        const json = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
        initializeApp({ credential: cert(json), projectId: env.FIREBASE_PROJECT_ID || json.project_id });
      } else {
        initializeApp(env.FIREBASE_PROJECT_ID ? { projectId: env.FIREBASE_PROJECT_ID } : undefined);
      }
    }
    return getFirestore();
  })();
  return db;
}

/** What the browser may see: no token, nothing it did not send itself apart from status. */
export function publicCloudBot(doc: CloudBotDoc | undefined) {
  if (!doc) return { configured: false };
  return {
    configured: true,
    enabled: doc.enabled,
    settings: doc.settings,
    allowReal: doc.allowReal,
    updatedAt: doc.updatedAt,
    hasToken: !!doc.tokenEnc,
    status: doc.status ?? null,
    recent: doc.recent ?? [],
  };
}
