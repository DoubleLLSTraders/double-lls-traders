import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { parseBotJson } from "../src/exports";
import { CLOUD_BOTS, cloudDb, publicCloudBot, type CloudBotDoc } from "./cloudBots";
import type { Kv } from "./kv";
import { deleteAccountApiData } from "./publicApi";
import { encryptToken } from "./tokenCrypto";

const TOKEN_MS = 30 * 86_400_000;
const MAX_TOKENS = 10;
const MAX_SESSIONS = 100;
const RECENT_TRADES = 100;
const EQUITY_POINTS = 120;
const BODY_LIMIT = 60_000;
const LOCK_FAILS = 10;
const LOCK_MS = 15 * 60_000;
const SIGNUPS_PER_HOUR = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ACCOUNT_TERMS_VERSION = "2026-10-02";

interface AccountLicence {
  licence: string;
  plan: string;
  email: string;
  version: string;
  addedAt: number;
}

interface User {
  id: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: number;
  lastLogin: number;
  termsVersion: string;
  /** Hashes of live sign-in tokens, newest last. */
  tokens: string[];
  fails: number[];
  settings: Record<string, unknown> | null;
  settingsAt: number;
  licences: AccountLicence[];
}

interface Token {
  userKey: string;
  exp: number;
}

interface Purchase {
  licence: string;
  plan: string;
  email: string;
  version: string;
}

const K = {
  user: (email: string) => `acct:user:${sha(email)}`,
  token: (hash: string) => `acct:tok:${hash}`,
  sessions: (userId: string) => `acct:ses:${userId}:`,
  session: (userId: string, id: string) => `acct:ses:${userId}:${id}`,
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const hashPassword = (password: string, salt: string) =>
  new Promise<string>((ok, fail) => scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? fail(err) : ok(key.toString("hex")))));

class AccountError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > BODY_LIMIT) throw new AccountError(413, "Request too large.");
  try {
    const v = text ? JSON.parse(text) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new AccountError(400, "Body must be JSON.");
  }
}

/** Keeps only the fields History and the test drive read, with bounded sizes. */
function cleanSession(input: unknown): Record<string, unknown> {
  const s = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  const id = s ? str(s.id, 40) : "";
  if (!s || !/^[\w-]{4,40}$/.test(id)) throw new AccountError(400, "Session needs an id.");
  const nums = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max).map(num) : []);
  const recent = Array.isArray(s.recent)
    ? s.recent.slice(0, RECENT_TRADES).map((t) => {
        const r = (t ?? {}) as Record<string, unknown>;
        return { id: num(r.id), digit: num(r.digit), label: str(r.label, 40), stake: num(r.stake), pnl: num(r.pnl), won: r.won === true };
      })
    : [];
  const byContract: Record<string, unknown> = {};
  if (s.byContract && typeof s.byContract === "object") {
    for (const [k, v] of Object.entries(s.byContract as Record<string, unknown>).slice(0, 12)) {
      const t = (v ?? {}) as Record<string, unknown>;
      byContract[str(k, 20)] = { trades: num(t.trades), wins: num(t.wins), pnl: num(t.pnl) };
    }
  }
  return {
    id,
    startedAt: num(s.startedAt),
    updatedAt: num(s.updatedAt),
    running: s.running === true,
    stopReason: typeof s.stopReason === "string" ? str(s.stopReason, 200) : null,
    mode: str(s.mode, 20),
    stake: num(s.stake),
    startBalance: num(s.startBalance),
    endBalance: num(s.endBalance),
    pnl: num(s.pnl),
    trades: num(s.trades),
    wins: num(s.wins),
    totalStaked: num(s.totalStaked),
    maxDrawdown: num(s.maxDrawdown),
    largestStake: num(s.largestStake),
    byContract,
    equity: nums(s.equity, EQUITY_POINTS),
    recent,
  };
}

/** The account behind a request's Bearer sign-in token, or null when it has none or it expired. */
export async function accountFromRequest(kv: Kv, req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith("acc_")) return null;
  const tokenHash = sha(token);
  const t = await kv.get<Token>(K.token(tokenHash));
  if (!t || t.exp < Date.now()) {
    if (t) await kv.delete(K.token(tokenHash));
    return null;
  }
  const user = await kv.get<User>(t.userKey);
  if (!user || !user.tokens.includes(tokenHash)) return null;
  return { user, userKey: t.userKey, tokenHash };
}

/** Files a paid licence under the account that bought it. */
export async function linkLicence(kv: Kv, userKey: string, p: Purchase) {
  await kv.update<User | null>(userKey, () => null, (u) => {
    if (!u || u.licences.some((l) => l.licence === p.licence)) return;
    u.licences.push({ licence: p.licence, plan: p.plan, email: p.email, version: p.version, addedAt: Date.now() });
  });
}

/**
 * Customer accounts: email + password sign-up, saved bot settings, test-drive sessions and licences.
 * Routes live under /api/account. Returns null for anything else.
 */
export function createAccounts(env: Record<string, string | undefined>, kv: Kv) {
  const signups = new Map<string, number[]>();

  const publicUser = (u: User) => ({ email: u.email, name: u.name, createdAt: u.createdAt });

  const issueToken = async (userKey: string) => {
    const token = `acc_${randomBytes(32).toString("base64url")}`;
    const hash = sha(token);
    await kv.set(K.token(hash), { userKey, exp: Date.now() + TOKEN_MS } satisfies Token);
    const dropped: string[] = [];
    await kv.update<User | null>(userKey, () => null, (u) => {
      if (!u) return;
      u.tokens.push(hash);
      dropped.push(...u.tokens.splice(0, Math.max(0, u.tokens.length - MAX_TOKENS)));
    });
    await Promise.all(dropped.map((h) => kv.delete(K.token(h))));
    return token;
  };

  const authed = async (req: Request) => {
    const found = await accountFromRequest(kv, req);
    if (!found) throw new AccountError(401, "Please sign in again.");
    return found;
  };

  const sessionsOf = async (userId: string) =>
    (await kv.list<Record<string, unknown>>(K.sessions(userId))).sort((a, b) => num(b.startedAt) - num(a.startedAt));

  const fullAccount = async (u: User) => ({
    account: publicUser(u),
    settings: u.settings,
    settingsAt: u.settingsAt,
    licences: u.licences,
    sessions: await sessionsOf(u.id),
  });

  const credentials = (body: Record<string, unknown>) => {
    const email = str(body.email, 120).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (!EMAIL_RE.test(email)) throw new AccountError(400, "Enter a valid email.");
    return { email, password };
  };

  return async (req: Request, ip: string): Promise<Response | null> => {
    const path = new URL(req.url).pathname;
    if (path !== "/api/account" && !path.startsWith("/api/account/")) return null;
    const route = `${req.method} ${path.slice("/api/account".length) || "/"}`;

    try {
      if (route === "POST /signup") {
        const body = await readJson(req);
        const { email, password } = credentials(body);
        if (password.length < 8 || password.length > 200) throw new AccountError(400, "Use a password of at least 8 characters.");
        if (body.acceptTerms !== true) throw new AccountError(400, "Please accept the Terms and Privacy Policy.");
        const now = Date.now();
        const recent = (signups.get(ip) ?? []).filter((t) => now - t < 3_600_000);
        if (recent.length >= SIGNUPS_PER_HOUR) throw new AccountError(429, "Too many new accounts from here. Try again later.");
        const userKey = K.user(email);
        if (await kv.get<User>(userKey)) throw new AccountError(409, "That email already has an account. Sign in instead.");
        const salt = randomBytes(16).toString("hex");
        const user: User = {
          id: randomBytes(9).toString("base64url"),
          email,
          name: str(body.name, 60),
          salt,
          hash: await hashPassword(password, salt),
          createdAt: now,
          lastLogin: now,
          termsVersion: ACCOUNT_TERMS_VERSION,
          tokens: [],
          fails: [],
          settings: null,
          settingsAt: 0,
          licences: [],
        };
        let taken = false;
        await kv.update<User | null>(userKey, () => null, (u) => {
          if (u) {
            taken = true;
            return u;
          }
          return user;
        });
        if (taken) throw new AccountError(409, "That email already has an account. Sign in instead.");
        recent.push(now);
        signups.set(ip, recent);
        const token = await issueToken(userKey);
        return json(201, { token, ...(await fullAccount(user)) });
      }

      if (route === "POST /login") {
        const { email, password } = credentials(await readJson(req));
        const userKey = K.user(email);
        const user = await kv.get<User>(userKey);
        const now = Date.now();
        const fails = (user?.fails ?? []).filter((t) => now - t < LOCK_MS);
        if (fails.length >= LOCK_FAILS) throw new AccountError(429, "Too many wrong passwords. Try again in 15 minutes.");
        const hash = await hashPassword(password, user?.salt ?? "no-account-salt");
        const ok = !!user && timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
        if (!ok) {
          if (user) {
            await kv.update<User | null>(userKey, () => null, (u) => {
              if (u) u.fails = [...u.fails.filter((t) => now - t < LOCK_MS), now];
            });
          }
          throw new AccountError(401, "Wrong email or password.");
        }
        const updated = await kv.update<User | null>(userKey, () => null, (u) => {
          if (!u) return;
          u.fails = [];
          u.lastLogin = now;
        });
        const token = await issueToken(userKey);
        return json(200, { token, ...(await fullAccount(updated ?? user)) });
      }

      const { user, userKey, tokenHash } = await authed(req);

      if (route === "GET /") return json(200, await fullAccount(user));

      if (route === "POST /logout") {
        await kv.delete(K.token(tokenHash));
        await kv.update<User | null>(userKey, () => null, (u) => {
          if (u) u.tokens = u.tokens.filter((h) => h !== tokenHash);
        });
        return json(200, { ok: true });
      }

      if (route === "PUT /settings") {
        const body = await readJson(req);
        const raw = body.settings && typeof body.settings === "object" ? body.settings : null;
        if (!raw) throw new AccountError(400, "Send { settings }.");
        const settings = parseBotJson(JSON.stringify({ format: "double-lls-trading-bot", settings: raw })) as unknown as Record<string, unknown>;
        const at = Date.now();
        await kv.update<User | null>(userKey, () => null, (u) => {
          if (!u) return;
          u.settings = settings;
          u.settingsAt = at;
        });
        return json(200, { ok: true, settingsAt: at });
      }

      if (route === "PUT /sessions") {
        const body = await readJson(req);
        const list = (Array.isArray(body.sessions) ? body.sessions : [body.session]).slice(0, 5).map(cleanSession);
        for (const s of list) {
          const key = K.session(user.id, s.id as string);
          await kv.update<Record<string, unknown> | null>(key, () => null, (prev) => (prev && num(prev.updatedAt) > num(s.updatedAt) ? prev : s));
        }
        const all = await sessionsOf(user.id);
        await Promise.all(all.slice(MAX_SESSIONS).map((s) => kv.delete(K.session(user.id, s.id as string))));
        return json(200, { ok: true, saved: list.length });
      }

      if (route === "DELETE /sessions") {
        const all = await sessionsOf(user.id);
        await Promise.all(all.map((s) => kv.delete(K.session(user.id, s.id as string))));
        return json(200, { ok: true, deleted: all.length });
      }

      if (route === "POST /licences") {
        const body = await readJson(req);
        const licence = str(body.licence, 32).toUpperCase();
        const p = ((await kv.get<Purchase[]>("purchases")) ?? []).find((x) => x.licence === licence);
        if (!p) throw new AccountError(404, "No licence matches that key.");
        const entry: AccountLicence = { licence: p.licence, plan: p.plan, email: p.email, version: str(body.version, 20) || p.version, addedAt: Date.now() };
        const updated = await kv.update<User | null>(userKey, () => null, (u) => {
          if (!u) return;
          const i = u.licences.findIndex((l) => l.licence === entry.licence);
          if (i >= 0) u.licences[i] = { ...u.licences[i], version: entry.version };
          else u.licences.push(entry);
        });
        return json(200, { licences: updated?.licences ?? [entry] });
      }

      if (route.endsWith(" /cloud-bot")) {
        const db = await cloudDb(env);
        if (!db || !env.CLOUD_BOT_KEY) throw new AccountError(503, "The cloud bot is not switched on for this site yet.");
        const ref = db.collection(CLOUD_BOTS).doc(user.id);

        if (req.method === "GET") return json(200, publicCloudBot((await ref.get()).data() as CloudBotDoc | undefined));

        if (req.method === "DELETE") {
          await ref.delete();
          return json(200, publicCloudBot(undefined));
        }

        if (req.method === "PUT") {
          const body = await readJson(req);
          const prev = (await ref.get()).data() as CloudBotDoc | undefined;
          const enabled = body.enabled === true;
          const licence = user.licences[user.licences.length - 1]?.licence ?? "";
          if (enabled && !licence) throw new AccountError(403, "The cloud bot comes with a licence. Add your licence key to this account first.");
          const derivToken = str(body.derivToken, 600);
          if (derivToken && !/^[\w.~+/=-]{8,512}$/.test(derivToken)) throw new AccountError(400, "That does not look like a Deriv access token.");
          if (enabled && !derivToken && !prev?.tokenEnc) throw new AccountError(400, "Paste a Deriv personal access token with Trade scope to start.");
          const rawSettings = body.settings && typeof body.settings === "object" ? body.settings : prev?.settings ?? {};
          const settings = parseBotJson(JSON.stringify({ format: "double-lls-trading-bot", settings: rawSettings }));
          const next: CloudBotDoc = {
            enabled,
            settings,
            tokenEnc: derivToken ? encryptToken(derivToken, env.CLOUD_BOT_KEY) : prev?.tokenEnc ?? "",
            allowReal: body.allowReal === true,
            email: user.email,
            licence,
            updatedAt: Date.now(),
          };
          await ref.set(next, { merge: true });
          return json(200, publicCloudBot({ ...prev, ...next }));
        }
      }

      if (route === "DELETE /") {
        const all = await sessionsOf(user.id);
        await (await cloudDb(env))?.collection(CLOUD_BOTS).doc(user.id).delete();
        await Promise.all([
          ...all.map((s) => kv.delete(K.session(user.id, s.id as string))),
          ...user.tokens.map((h) => kv.delete(K.token(h))),
          deleteAccountApiData(kv, user.id),
        ]);
        await kv.delete(userKey);
        return json(200, { ok: true });
      }

      return json(404, { error: "Not found." });
    } catch (err) {
      if (err instanceof AccountError) return json(err.status, { error: err.message });
      if (err instanceof Error && /settings file/.test(err.message)) return json(400, { error: "Those settings are not valid." });
      console.error("[accounts]", err);
      return json(500, { error: "Something went wrong. Try again." });
    }
  };
}
