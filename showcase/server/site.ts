import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { KES_PER_USD, quote, type PlanId } from "../src/pricing";
import { accountFromRequest, linkLicence, unlinkLicence } from "./accounts";
import type { Kv } from "./kv";
import {
  capturePayPalOrder,
  createPayPalOrder,
  mpesaEnabled,
  normalizeKenyanPhone,
  paypalConfig,
  startStkPush,
  stkStatus,
  verifyPayPalWebhook,
  type PaymentEnv,
  type PayPalWebhookEvent,
} from "./payments";

const LIVE_MS = 15_000;
const MAX_EVENTS = 3000;
const MAX_VISITORS = 3000;
const MAX_REVIEWS = 2000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILS = 10;
const SESSION_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;
const BODY_LIMIT = 16_000;
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const EVENT_TYPES = new Set(["visit", "test_click", "bot_start", "checkout_open", "purchase", "download", "review", "licence_open"]);
const PAGES = new Set(["landing", "test", "checkout", "licence"]);

interface Visitor {
  id: string;
  firstSeen: number;
  lastSeen: number;
  visits: number;
  testClicks: number;
  device: string;
  lang: string;
  tz: string;
  referrer: string;
  email?: string;
  name?: string;
}

interface SiteEvent {
  at: number;
  visitorId: string;
  type: string;
  detail?: string;
}

interface Activity {
  visitors: Record<string, Visitor>;
  events: SiteEvent[];
}

interface Review {
  id: string;
  at: number;
  visitorId: string;
  rating: number;
  text: string;
  name: string;
  streak: number;
  hidden: boolean;
}

interface Purchase {
  orderId: string;
  at: number;
  visitorId: string;
  licence: string;
  plan: string;
  email: string;
  name: string;
  method: string;
  coupon: string;
  licencePrice: number;
  setupFee: number;
  total: number;
  version: string;
  /** What the provider actually took, in its currency (USD for PayPal/card, KES for M-Pesa). */
  paid?: number;
  currency?: string;
  /** PayPal capture id or M-Pesa receipt. */
  paymentRef?: string;
  /** PayPal order id or PayHero reference the purchase was fulfilled from. */
  providerKey?: string;
  phone?: string;
  /** Customer account that paid. */
  accountId?: string;
  /** Set when PayPal reports the payment refunded or reversed; the licence stops working. */
  refunded?: { at: number; reason: "refunded" | "reversed" };
}

/** A checkout that has been sent to PayPal or M-Pesa but not confirmed yet. */
interface PendingOrder {
  orderId: string;
  at: number;
  visitorId: string;
  method: "paypal" | "card" | "mpesa";
  plan: PlanId;
  coupon: string | null;
  email: string;
  name: string;
  phone: string;
  total: number;
  totalKes: number;
  accountId?: string;
  accountKey?: string;
  /** PayPal is holding the payment for review; kept until the webhook settles it. */
  review?: boolean;
}

const REVIEW_KEEP_MS = 30 * 86_400_000;

interface Install {
  licence: string;
  format: string;
  version: string;
  firstSeen: number;
  lastSeen: number;
  runs: number;
}

interface Release {
  version: string;
  notes: string;
  at: number;
}

interface LiveBot {
  running: boolean;
  balance: number;
  startBalance: number;
  pnl: number;
  trades: number;
  winRate: number;
  mode: string;
  speed: number;
}

interface Presence {
  visitorId: string;
  page: string;
  since: number;
  lastSeen: number;
  bot: LiveBot | null;
}

const K = {
  activity: "activity",
  reviews: "reviews",
  purchases: "purchases",
  /** Keyed by PayPal order id or PayHero reference. */
  pending: "pending",
  installs: "installs",
  releases: "releases",
  loginFails: "admin-login-fails",
  presence: "presence/",
} as const;

const emptyActivity = (): Activity => ({ visitors: {}, events: [] });
const firstRelease = (): Release[] => [{ version: "1.0.0", notes: "First release.", at: Date.now() }];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const id = (v: unknown) => (typeof v === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(v) ? v : "");
const digest = (s: string) => createHash("sha256").update(s).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export function compareVersions(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function newLicence() {
  const raw = randomBytes(9).toString("base64").replace(/[^A-Z0-9]/gi, "").toUpperCase().padEnd(12, "X").slice(0, 12);
  return `LLS-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > BODY_LIMIT) throw Object.assign(new Error("Request too large."), { status: 413 });
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export type SiteHandler = (req: Request, ip: string) => Promise<Response | null>;

/**
 * The site's own data API: visitor tracking, live presence, reviews, payments and licences, bot update checks,
 * and the admin endpoints (email + password sign-in, signed session token). Returns null for paths it does not own.
 */
export function createSiteApi(env: Record<string, string | undefined>, kv: Kv): SiteHandler {
  const adminEmail = (env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const adminPassword = env.ADMIN_PASSWORD ?? "";
  const sessionKey = digest(`llsbot-admin|${adminEmail}|${adminPassword}`);
  const payEnv = env as PaymentEnv;
  const hits = new Map<string, number[]>();

  const rateLimited = (ip: string) => {
    const now = Date.now();
    const list = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    list.push(now);
    hits.set(ip, list);
    return list.length > RATE_MAX;
  };

  const releases = async () => (await kv.get<Release[]>(K.releases)) ?? firstRelease();
  const latest = async () => {
    const all = await releases();
    return all[all.length - 1];
  };

  const touchIn = (a: Activity, visitorId: string, patch: Partial<Visitor> = {}) => {
    const now = Date.now();
    const v = a.visitors[visitorId] ?? {
      id: visitorId, firstSeen: now, lastSeen: now, visits: 0, testClicks: 0, device: "", lang: "", tz: "", referrer: "",
    };
    Object.assign(v, patch, { lastSeen: now });
    a.visitors[visitorId] = v;
    const ids = Object.keys(a.visitors);
    if (ids.length > MAX_VISITORS) {
      ids.sort((x, y) => a.visitors[x].lastSeen - a.visitors[y].lastSeen);
      for (const old of ids.slice(0, ids.length - MAX_VISITORS)) delete a.visitors[old];
    }
    return v;
  };

  const logIn = (a: Activity, visitorId: string, type: string, detail?: string) => {
    a.events.push({ at: Date.now(), visitorId, type, ...(detail ? { detail } : {}) });
    if (a.events.length > MAX_EVENTS) a.events.splice(0, a.events.length - MAX_EVENTS);
  };

  const record = (visitorId: string, type: string, detail?: string, patch?: Partial<Visitor>) =>
    kv.update(K.activity, emptyActivity, (a) => {
      touchIn(a, visitorId, patch);
      logIn(a, visitorId, type, detail);
    });

  /* ---------- admin session ---------- */

  const sign = (exp: number) => createHmac("sha256", sessionKey).update(String(exp)).digest("base64url");
  const newSession = () => {
    const exp = Date.now() + SESSION_MS;
    return `${exp}.${sign(exp)}`;
  };
  const isAdmin = (req: Request) => {
    if (!adminPassword) return false;
    const token = req.headers.get("x-admin-key") ?? "";
    const [expRaw, mac] = token.split(".");
    const exp = Number(expRaw);
    return !!mac && Number.isFinite(exp) && exp > Date.now() && same(mac, sign(exp));
  };

  const loginFailures = async (ip: string) => {
    const now = Date.now();
    const all = (await kv.get<Record<string, number[]>>(K.loginFails)) ?? {};
    return (all[ip] ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  };
  const addLoginFailure = (ip: string) =>
    kv.update<Record<string, number[]>>(K.loginFails, () => ({}), (all) => {
      const now = Date.now();
      for (const k of Object.keys(all)) {
        all[k] = all[k].filter((t) => now - t < LOGIN_WINDOW_MS);
        if (!all[k].length) delete all[k];
      }
      (all[ip] ??= []).push(now);
    });

  /* ---------- presence ---------- */

  const livePresence = async () => {
    const now = Date.now();
    const all = await kv.list<Presence>(K.presence);
    const stale = all.filter((p) => now - p.lastSeen > LIVE_MS * 4);
    await Promise.all(stale.map((p) => kv.delete(K.presence + p.visitorId)));
    return all.filter((p) => now - p.lastSeen < LIVE_MS);
  };

  /* ---------- admin overview ---------- */

  const overview = async () => {
    const now = Date.now();
    const [activity, reviews, purchases, installsMap, allReleases, live] = await Promise.all([
      kv.get<Activity>(K.activity).then((a) => a ?? emptyActivity()),
      kv.get<Review[]>(K.reviews).then((r) => r ?? []),
      kv.get<Purchase[]>(K.purchases).then((p) => p ?? []),
      kv.get<Record<string, Install>>(K.installs).then((i) => i ?? {}),
      releases(),
      livePresence(),
    ]);
    const visitors = Object.values(activity.visitors);
    const dayStart = new Date().setHours(0, 0, 0, 0);
    const shown = reviews.filter((r) => !r.hidden);
    const installs = Object.values(installsMap);
    const current = allReleases[allReleases.length - 1];
    const days = Array.from({ length: 14 }, (_, i) => {
      const start = dayStart - (13 - i) * DAY_MS;
      const inDay = activity.events.filter((e) => e.at >= start && e.at < start + DAY_MS);
      return {
        day: start,
        visitors: new Set(inDay.filter((e) => e.type === "visit").map((e) => e.visitorId)).size,
        testers: new Set(inDay.filter((e) => e.type === "test_click").map((e) => e.visitorId)).size,
        purchases: inDay.filter((e) => e.type === "purchase").length,
      };
    });
    return {
      now,
      release: current,
      releases: [...allReleases].reverse(),
      totals: {
        live: live.length,
        liveTesting: live.filter((p) => p.page === "test").length,
        visitors: visitors.length,
        visitorsToday: visitors.filter((v) => v.lastSeen >= dayStart).length,
        testers: visitors.filter((v) => v.testClicks > 0).length,
        testClicks: visitors.reduce((a, v) => a + v.testClicks, 0),
        purchases: purchases.length,
        revenue: purchases.reduce((a, p) => a + (p.refunded ? 0 : p.total), 0),
        reviews: shown.length,
        rating: shown.length ? shown.reduce((a, r) => a + r.rating, 0) / shown.length : 0,
        installs: installs.length,
        activeInstalls: installs.filter((i) => now - i.lastSeen < DAY_MS).length,
        outdated: installs.filter((i) => compareVersions(i.version, current.version) < 0).length,
      },
      days,
      live: live.map((p) => ({ ...p, visitor: activity.visitors[p.visitorId] ?? null })),
      reviews: [...reviews].reverse(),
      purchases: [...purchases].reverse(),
      installs: installs.sort((a, b) => b.lastSeen - a.lastSeen),
      visitors: visitors.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 300),
      events: activity.events.slice(-300).reverse(),
    };
  };

  /* ---------- payments ---------- */

  const siteUrl = (req: Request) => (payEnv.SITE_URL || new URL(req.url).origin).replace(/\/+$/, "");

  const newPending = (visitorId: string, body: Record<string, unknown>, method: PendingOrder["method"]): PendingOrder | { error: string } => {
    const email = str(body.email, 120).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email for your licence." };
    const q = quote(str(body.plan, 20), str(body.coupon, 20));
    if (!q) return { error: "Choose a plan." };
    const account = body.account as { id: string; key: string } | undefined;
    return {
      ...(account ? { accountId: account.id, accountKey: account.key } : {}),
      orderId: `LLS-${randomBytes(4).toString("hex").toUpperCase()}`,
      at: Date.now(),
      visitorId,
      method,
      plan: q.plan.id,
      coupon: q.coupon,
      email,
      name: str(body.name, 80),
      phone: str(body.phone, 20),
      total: q.total,
      totalKes: q.totalKes,
    };
  };

  const savePending = (key: string, order: PendingOrder) =>
    kv.update<Record<string, PendingOrder>>(K.pending, () => ({}), (all) => {
      const now = Date.now();
      for (const [k, p] of Object.entries(all)) if (now - p.at > (p.review ? REVIEW_KEEP_MS : DAY_MS)) delete all[k];
      all[key] = order;
    });
  const markReview = (key: string) =>
    kv.update<Record<string, PendingOrder>>(K.pending, () => ({}), (all) => {
      if (all[key]) all[key].review = true;
    });

  /** Turns off the licence behind a refunded or reversed PayPal payment. */
  const revoke = async (captureId: string, orderId: string, reason: "refunded" | "reversed") => {
    let hit: Purchase | null = null;
    await kv.update<Purchase[]>(K.purchases, () => [], (all) => {
      const p = all.find((x) => (captureId && x.paymentRef === captureId) || (orderId && x.providerKey === orderId));
      if (!p || p.refunded) return;
      p.refunded = { at: Date.now(), reason };
      hit = p;
    });
    const p = hit as Purchase | null;
    if (p) {
      await unlinkLicence(kv, p.email, p.licence);
      await record(p.visitorId, "purchase", `${reason} · ${p.licence}`);
    }
    return p;
  };
  const getPending = async (key: string) => ((await kv.get<Record<string, PendingOrder>>(K.pending)) ?? {})[key] ?? null;
  const dropPending = (key: string) =>
    kv.update<Record<string, PendingOrder>>(K.pending, () => ({}), (all) => {
      delete all[key];
    });

  const licenceReply = (p: Purchase) => ({
    status: "paid",
    orderId: p.orderId,
    licence: p.licence,
    version: p.version,
    plan: p.plan,
    email: p.email,
    paid: p.paid ?? p.total,
    currency: p.currency ?? "USD",
  });

  /** Already-fulfilled payment for this provider key, so retries and double clicks never issue two licences. */
  const paidFor = async (key: string) => {
    const p = ((await kv.get<Purchase[]>(K.purchases)) ?? []).find((x) => x.providerKey === key);
    return p ? licenceReply(p) : null;
  };

  const fulfil = async (key: string, order: PendingOrder, pay: { paid: number; currency: string; paymentRef: string; name?: string }) => {
    const q = quote(order.plan, order.coupon)!;
    const version = (await latest()).version;
    let result: Purchase | null = null;
    let created = false;
    await kv.update<Purchase[]>(K.purchases, () => [], (all) => {
      created = false;
      const existing = all.find((x) => x.orderId === order.orderId || x.providerKey === key);
      if (existing) {
        result = existing;
        return;
      }
      result = {
        orderId: order.orderId,
        at: Date.now(),
        visitorId: order.visitorId,
        licence: newLicence(),
        plan: q.plan.name,
        email: order.email,
        name: pay.name ?? order.name,
        method: order.method,
        coupon: order.coupon ?? "",
        licencePrice: q.licence,
        setupFee: q.plan.setupFee,
        total: q.total,
        version,
        paid: pay.paid,
        currency: pay.currency,
        paymentRef: pay.paymentRef,
        providerKey: key,
        ...(order.phone ? { phone: order.phone } : {}),
        ...(order.accountId ? { accountId: order.accountId } : {}),
      };
      all.push(result);
      created = true;
    });
    const purchase = result as unknown as Purchase;
    if (created) {
      if (order.accountKey) await linkLicence(kv, order.accountKey, purchase);
      await dropPending(key);
      await record(order.visitorId, "purchase", `${purchase.plan} $${purchase.total.toFixed(2)} · ${order.method}`, {
        email: order.email,
        ...(purchase.name ? { name: purchase.name } : {}),
      });
    }
    return licenceReply(purchase);
  };

  const checkMpesa = async (reference: string) => {
    const done = await paidFor(reference);
    if (done) return done;
    const order = await getPending(reference);
    if (!order) return { status: "failed", message: "Unknown payment. Start again." };
    const st = await stkStatus(payEnv, reference);
    if (st.status === "failed") {
      await dropPending(reference);
      return { status: "failed", message: st.message || "The M-Pesa payment was cancelled or failed." };
    }
    if (st.status !== "paid") return { status: "pending" };
    if (st.amount && st.amount + 1 < order.totalKes) return { status: "failed", message: `M-Pesa received KES ${st.amount}, but this costs KES ${order.totalKes}.` };
    return fulfil(reference, order, { paid: st.amount || order.totalKes, currency: "KES", paymentRef: st.receipt || reference });
  };

  /* ---------- routes ---------- */

  const admin = async (req: Request, path: string, ip: string) => {
    if (!adminPassword) return json(503, { error: "Admin sign-in is not set up yet." });

    if (path === "/api/admin/login" && req.method === "POST") {
      if ((await loginFailures(ip)).length >= LOGIN_MAX_FAILS) return json(429, { error: "Too many wrong attempts. Try again in 15 minutes." });
      const body = await readJson(req);
      const emailOk = !adminEmail || same(str(body.email, 200).toLowerCase(), adminEmail);
      const passOk = same(typeof body.password === "string" ? body.password : "", adminPassword);
      if (!emailOk || !passOk) {
        await addLoginFailure(ip);
        return json(401, { error: "Wrong email or password." });
      }
      return json(200, { token: newSession() });
    }

    if (!isAdmin(req)) return json(401, { error: "Please sign in again." });

    if (path === "/api/admin/overview" && req.method === "GET") return json(200, await overview());
    if (req.method !== "POST") return json(405, { error: "Use POST." });
    const body = await readJson(req);

    if (path === "/api/admin/release") {
      const version = str(body.version, 20);
      const notes = str(body.notes, 1000);
      if (!VERSION_RE.test(version)) return json(400, { error: "Use a version like 1.2.0." });
      const current = await latest();
      if (compareVersions(version, current.version) <= 0) return json(400, { error: `Must be newer than ${current.version}.` });
      await kv.update<Release[]>(K.releases, firstRelease, (all) => {
        all.push({ version, notes, at: Date.now() });
      });
      return json(200, await overview());
    }

    if (path === "/api/admin/review") {
      let found = false;
      await kv.update<Review[]>(K.reviews, () => [], (all) => {
        const i = all.findIndex((r) => r.id === body.id);
        found = i >= 0;
        if (i < 0) return;
        if (body.action === "delete") all.splice(i, 1);
        else all[i].hidden = body.action === "hide";
      });
      if (!found) return json(404, { error: "Review not found." });
      return json(200, await overview());
    }

    return json(404, { error: "Not found." });
  };

  return async (req, ip) => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith("/api/") || path.startsWith("/api/assistant")) return null;

    try {
      // Called by downloaded bots from any machine.
      if (path === "/api/bot/version") {
        const cors = { "Access-Control-Allow-Origin": "*" };
        if (rateLimited(ip)) return json(429, { error: "Too many requests." }, cors);
        const release = await latest();
        const have = str(url.searchParams.get("v"), 20);
        const licence = str(url.searchParams.get("licence"), 32);
        const format = str(url.searchParams.get("format"), 20);
        if (licence && format && VERSION_RE.test(have)) {
          await kv.update<Record<string, Install>>(K.installs, () => ({}), (all) => {
            const key = `${licence}|${format}`;
            const now = Date.now();
            const prev = all[key];
            all[key] = { licence, format, version: have, firstSeen: prev?.firstSeen ?? now, lastSeen: now, runs: (prev?.runs ?? 0) + 1 };
          });
        }
        const bought = licence ? ((await kv.get<Purchase[]>(K.purchases)) ?? []).find((p) => p.licence === licence) : undefined;
        return json(200, {
          ...(licence ? { licenceActive: !!bought && !bought.refunded } : {}),
          latest: release.version,
          notes: release.notes,
          released: release.at,
          updateAvailable: VERSION_RE.test(have) && compareVersions(have, release.version) < 0,
          downloadUrl: `${siteUrl(req)}/#/licence`,
        }, cors);
      }

      if (path === "/api/release" && req.method === "GET") return json(200, await latest());

      if (path === "/api/pay/config" && req.method === "GET") {
        const pp = paypalConfig(payEnv);
        return json(200, {
          paypal: pp.enabled,
          paypalClientId: pp.enabled ? pp.clientId : "",
          sandbox: pp.sandbox,
          mpesa: mpesaEnabled(payEnv),
          kesPerUsd: KES_PER_USD,
        });
      }

      if (path === "/api/pay/mpesa/status" && req.method === "GET") {
        if (rateLimited(ip)) return json(429, { error: "Too many requests." });
        return json(200, await checkMpesa(str(url.searchParams.get("reference"), 60)));
      }

      // PayHero posts here when the customer finishes on their phone. The body is not trusted;
      // it only triggers a status check against the PayHero API.
      if (path === "/api/pay/mpesa/callback" && req.method === "POST") {
        const raw = (await readJson(req)) as { response?: Record<string, unknown> } & Record<string, unknown>;
        const r = raw.response ?? raw;
        const ext = String(r.ExternalReference ?? r.external_reference ?? "");
        const pending = (await kv.get<Record<string, PendingOrder>>(K.pending)) ?? {};
        const ref = Object.keys(pending).find((k) => k === String(r.reference ?? "") || pending[k].orderId === ext);
        if (ref) await checkMpesa(ref).catch(() => {});
        return json(200, { ok: true });
      }

      // PayPal webhook: settles payments held for review and turns off licences for refunds and reversals.
      // Only acted on once PayPal confirms the signature.
      if (path === "/api/pay/paypal/webhook" && req.method === "POST") {
        if (!payEnv.PAYPAL_WEBHOOK_ID) return json(503, { error: "PAYPAL_WEBHOOK_ID is not set." });
        const event = (await readJson(req)) as PayPalWebhookEvent;
        if (!(await verifyPayPalWebhook(payEnv, req.headers, event))) return json(400, { error: "Signature check failed." });
        const r = event.resource ?? {};
        const orderId = r.supplementary_data?.related_ids?.order_id ?? "";
        const upCapture = (r.links ?? []).find((l) => l.rel === "up" && /\/captures\//.test(l.href ?? ""))?.href?.split("/").pop() ?? "";

        if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" && orderId && !(await paidFor(orderId))) {
          const order = await getPending(orderId);
          const amount = Number(r.amount?.value ?? 0);
          if (order && r.amount?.currency_code === "USD" && amount + 0.01 >= order.total) {
            await fulfil(orderId, order, { paid: amount, currency: "USD", paymentRef: r.id ?? "" });
          }
        } else if (event.event_type === "PAYMENT.CAPTURE.DENIED" && orderId) {
          await dropPending(orderId);
        } else if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
          await revoke(upCapture, orderId, "refunded");
        } else if (event.event_type === "PAYMENT.CAPTURE.REVERSED") {
          await revoke(r.id ?? "", orderId, "reversed");
        }
        return json(200, { ok: true });
      }

      if (path.startsWith("/api/admin")) return await admin(req, path, ip);

      if (req.method !== "POST") return json(405, { error: "Use POST." });
      if (rateLimited(ip)) return json(429, { error: "Too many requests." });
      const body = await readJson(req);
      const visitorId = id(body.visitorId);
      if (!visitorId) return json(400, { error: "Missing visitor id." });

      if (path === "/api/track") {
        const type = str(body.type, 30);
        if (!EVENT_TYPES.has(type)) return json(400, { error: "Unknown event." });
        await kv.update(K.activity, emptyActivity, (a) => {
          const v = touchIn(a, visitorId);
          if (type === "visit") {
            v.visits += 1;
            v.device = str(body.device, 20) || v.device;
            v.lang = str(body.lang, 20) || v.lang;
            v.tz = str(body.tz, 60) || v.tz;
            v.referrer = str(body.referrer, 200) || v.referrer;
          }
          if (type === "test_click") v.testClicks += 1;
          logIn(a, visitorId, type, str(body.detail, 120) || undefined);
        });
        return json(200, { ok: true });
      }

      if (path === "/api/presence") {
        const page = str(body.page, 20);
        if (!PAGES.has(page)) return json(400, { error: "Unknown page." });
        const b = body.bot as Record<string, unknown> | null | undefined;
        const bot: LiveBot | null = b && typeof b === "object"
          ? {
              running: b.running === true,
              balance: num(b.balance),
              startBalance: num(b.startBalance),
              pnl: num(b.pnl),
              trades: num(b.trades),
              winRate: num(b.winRate),
              mode: str(b.mode, 20),
              speed: num(b.speed),
            }
          : null;
        const now = Date.now();
        const prev = await kv.get<Presence>(K.presence + visitorId);
        await kv.set(K.presence + visitorId, {
          visitorId,
          page,
          since: prev && prev.page === page && now - prev.lastSeen < LIVE_MS * 4 ? prev.since : now,
          lastSeen: now,
          bot,
        } satisfies Presence);
        return json(200, { ok: true });
      }

      if (path === "/api/reviews") {
        const rating = Math.round(num(body.rating));
        if (rating < 1 || rating > 5) return json(400, { error: "Rating must be 1 to 5 stars." });
        const review: Review = {
          id: randomBytes(6).toString("hex"),
          at: Date.now(),
          visitorId,
          rating,
          text: str(body.text, 1000),
          name: str(body.name, 60),
          streak: Math.max(0, Math.round(num(body.streak))),
          hidden: false,
        };
        await kv.update<Review[]>(K.reviews, () => [], (all) => {
          all.push(review);
          if (all.length > MAX_REVIEWS) all.splice(0, all.length - MAX_REVIEWS);
        });
        await record(visitorId, "review", `${rating}★`, review.name ? { name: review.name } : {});
        return json(200, { ok: true });
      }

      if (path === "/api/pay/paypal/create" || path === "/api/pay/mpesa/start") {
        const buyer = await accountFromRequest(kv, req);
        if (!buyer) return json(401, { error: "Sign in to your account to purchase." });
        body.email = buyer.user.email;
        body.name = str(body.name, 80) || buyer.user.name;
        body.account = { id: buyer.user.id, key: buyer.userKey };
      }

      if (path === "/api/pay/paypal/create") {
        const order = newPending(visitorId, body, body.method === "card" ? "card" : "paypal");
        if ("error" in order) return json(400, { error: order.error });
        const ppId = await createPayPalOrder(payEnv, {
          reference: order.orderId,
          description: `Double LLS Trading Bot - ${quote(order.plan)!.plan.name} licence + setup`,
          totalUsd: order.total,
        });
        await savePending(ppId, order);
        return json(200, { id: ppId });
      }

      if (path === "/api/pay/paypal/capture") {
        const ppId = str(body.orderId, 40);
        const done = await paidFor(ppId);
        if (done) return json(200, done);
        const order = await getPending(ppId);
        if (!order) return json(404, { error: "Unknown order." });
        const cap = await capturePayPalOrder(payEnv, ppId);
        if (cap.pending) {
          await markReview(ppId);
          return json(202, {
            status: "pending",
            orderId: order.orderId,
            message: "PayPal is reviewing this payment. Your licence is added to your account automatically as soon as it clears, usually within a day.",
          });
        }
        if (!cap.paid) return json(402, { error: "PayPal did not complete the payment." });
        if (cap.currency !== "USD" || cap.amount + 0.01 < order.total) {
          return json(402, { error: `PayPal shows ${cap.currency} ${cap.amount}, but this costs $${order.total.toFixed(2)}.` });
        }
        return json(200, await fulfil(ppId, order, { paid: cap.amount, currency: "USD", paymentRef: cap.captureId, name: order.name || cap.payerName }));
      }

      if (path === "/api/pay/mpesa/start") {
        const phone = normalizeKenyanPhone(str(body.phone, 20));
        if (!/^0[17]\d{8}$/.test(phone)) return json(400, { error: "Enter your Safaricom number, like 0712 345 678." });
        const order = newPending(visitorId, { ...body, phone }, "mpesa");
        if ("error" in order) return json(400, { error: order.error });
        const stk = await startStkPush(payEnv, {
          phone,
          amountKes: order.totalKes,
          externalReference: order.orderId,
          customerName: order.name || undefined,
          callbackUrl: `${siteUrl(req)}/api/pay/mpesa/callback`,
        });
        await savePending(stk.reference, order);
        return json(200, { reference: stk.reference, amountKes: order.totalKes });
      }

      if (path === "/api/licence") {
        const licence = str(body.licence, 32).toUpperCase();
        const email = str(body.email, 120).toLowerCase();
        const p = ((await kv.get<Purchase[]>(K.purchases)) ?? []).find((x) => x.licence === licence && x.email === email);
        if (!p) return json(404, { error: "No licence matches that key and email." });
        if (p.refunded) return json(403, { error: `This licence was ${p.refunded.reason} and is no longer active.` });
        await record(visitorId, "licence_open", p.licence);
        return json(200, { licence: p.licence, plan: p.plan, email: p.email, version: p.version });
      }

      return json(404, { error: "Not found." });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (!(typeof status === "number" && status >= 400)) console.error("[site-api]", err);
      return json(typeof status === "number" && status >= 400 ? status : 500, { error: err instanceof Error ? err.message : "Request failed." });
    }
  };
}
