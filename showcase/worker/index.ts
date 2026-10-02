/**
 * Double LLS cloud bot worker. Runs every enabled bot in the cloudBots Firestore collection,
 * one Deriv connection each, and writes their status back. Runs on any always-on Node host (Belmo, Cloud Run).
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { CLOUD_BOTS, cloudDb, type CloudBotDoc } from "../server/cloudBots";
import { decryptToken } from "../server/tokenCrypto";
import { LiveRunner } from "./liveRunner";

/** Status is saved once a minute at most, so each bot costs about 1,440 Firestore writes a day (free plan: 20,000). */
const FLUSH_MS = 60_000;
const HEARTBEAT_MS = 60_000;
/** A new instance claims this lease and waits this long, so the instance it replaces stops trading first. */
const HANDOVER_MS = 5_000;
const env = process.env;

/** Hosts health-check the port right away, before Firestore and Deriv are ready. */
if (env.PORT) createServer((_, res) => res.end("ok")).listen(Number(env.PORT));
const APP_ID = env.DERIV_APP_ID?.trim() ?? "";
const REST_URL = env.DERIV_REST_URL?.trim() || undefined;

interface Entry {
  runner: LiveRunner;
  updatedAt: number;
  dirty: boolean;
  lastFlush: number;
}

const log = (id: string, message: string) => console.log(`[${id}] ${message}`);
const db = await cloudDb(env);
if (!db) {
  console.error("No Firestore access. Run on Google Cloud, or set FIREBASE_SERVICE_ACCOUNT.");
  process.exit(1);
}
if (!env.CLOUD_BOT_KEY) {
  console.error("CLOUD_BOT_KEY is not set.");
  process.exit(1);
}
if (!APP_ID) {
  console.error("DERIV_APP_ID is not set. Use the app id from your Deriv developer dashboard.");
  process.exit(1);
}

const collection = db.collection(CLOUD_BOTS);
const entries = new Map<string, Entry>();

async function flush(id: string, entry: Entry) {
  entry.dirty = false;
  entry.lastFlush = Date.now();
  const { runner } = entry;
  try {
    await collection.doc(id).update({ status: { ...runner.status, heartbeat: entry.lastFlush }, recent: runner.recent });
  } catch (err) {
    log(id, `could not save status: ${err instanceof Error ? err.message : err}`);
  }
}

function start(id: string, doc: CloudBotDoc) {
  let token: string;
  try {
    token = decryptToken(doc.tokenEnc, env.CLOUD_BOT_KEY);
  } catch {
    log(id, "token could not be decrypted");
    void collection.doc(id).update({ "status.state": "error", "status.message": "Saved token is unreadable. Paste it again on the website." });
    return;
  }
  const entry: Entry = { runner: null!, updatedAt: doc.updatedAt, dirty: true, lastFlush: 0 };
  entry.runner = new LiveRunner({
    settings: doc.settings,
    token,
    allowReal: doc.allowReal,
    appId: APP_ID,
    restUrl: REST_URL,
    onChange: () => (entry.dirty = true),
    log: (m) => log(id, m),
  });
  entries.set(id, entry);
  entry.runner.start();
  log(id, `started (${doc.settings.mode}, ${doc.settings.symbol})`);
}

async function stop(id: string, message: string, save: boolean) {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  entry.runner.stop(message);
  if (save) await flush(id, entry);
  log(id, message);
}

const me = randomUUID();
const lease = db.collection("cloudMeta").doc("worker");
let handedOver = false;
await lease.set({ owner: me, at: Date.now() });
lease.onSnapshot(async (snap) => {
  const owner = snap.get("owner");
  if (handedOver || !owner || owner === me) return;
  handedOver = true;
  console.log("A newer instance took over; stopping here.");
  await Promise.all([...entries.keys()].map((id) => stop(id, "Server restarting, the bot resumes in a moment", true)));
  process.exit(0);
});
await new Promise((r) => setTimeout(r, HANDOVER_MS));

collection.onSnapshot(
  (snap) => {
    if (handedOver) return;
    for (const change of snap.docChanges()) {
      const id = change.doc.id;
      const doc = change.doc.data() as CloudBotDoc;
      const entry = entries.get(id);
      if (change.type === "removed") {
        void stop(id, "Removed", false);
        continue;
      }
      if (!doc.enabled || !doc.tokenEnc) {
        if (entry) void stop(id, "Stopped from the website", true);
        continue;
      }
      if (entry?.updatedAt === doc.updatedAt) continue;
      if (entry) entry.runner.stop("Restarting with new settings");
      entries.delete(id);
      start(id, doc);
    }
  },
  (err) => {
    console.error("Firestore listener failed:", err);
    process.exit(1);
  },
);

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (entry.dirty || now - entry.lastFlush >= HEARTBEAT_MS) void flush(id, entry);
  }
}, FLUSH_MS);

/** Hosts send SIGTERM before replacing an instance; bots stay enabled and the next instance picks them up. */
process.on("SIGTERM", async () => {
  if (!handedOver) {
    handedOver = true;
    await Promise.all([...entries.keys()].map((id) => stop(id, "Server restarting, the bot resumes in a moment", true)));
  }
  process.exit(0);
});

console.log(`Cloud bot worker up (Deriv app ${APP_ID}).`);
