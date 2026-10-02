import { useEffect, useState } from "react";

const VISITOR_KEY = "double-lls:visitor:v1";
const LICENCE_KEY = "double-lls:licence:v1";
export const ACCOUNT_KEY = "double-lls:account:v1";

function accountToken(): string {
  try {
    return (JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null") as { token?: string } | null)?.token ?? "";
  } catch {
    return "";
  }
}
export const LICENCE_EVENT = "double-lls:licence";

export type SitePage = "landing" | "test" | "checkout" | "licence";
export type SiteEventType = "visit" | "test_click" | "bot_start" | "checkout_open" | "purchase" | "download" | "review" | "licence_open";

export interface Release {
  version: string;
  notes: string;
  at: number;
}

export interface Licence {
  licence: string;
  plan: string;
  email: string;
  /** Version of the bot files last downloaded on this device. */
  version: string;
}

export interface LiveBotState {
  running: boolean;
  balance: number;
  startBalance: number;
  pnl: number;
  trades: number;
  winRate: number;
  mode: string;
  speed: number;
}

export function visitorId(): string {
  try {
    let v = localStorage.getItem(VISITOR_KEY);
    if (!v) {
      v = `v_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      localStorage.setItem(VISITOR_KEY, v);
    }
    return v;
  } catch {
    return "v_anonymous_device";
  }
}

async function post<T>(path: string, body: Record<string, unknown>, keepalive = false): Promise<T> {
  const token = accountToken();
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ visitorId: visitorId(), ...body }),
    keepalive,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export function track(type: SiteEventType, detail?: string, extra: Record<string, unknown> = {}) {
  void post("/api/track", { type, detail, ...extra }, true).catch(() => {});
}

export function trackVisit() {
  track("visit", location.hash || undefined, {
    device: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "mobile" : "desktop",
    lang: navigator.language,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    referrer: document.referrer,
  });
}

export function sendPresence(page: SitePage, bot: LiveBotState | null) {
  void post("/api/presence", { page, bot }, true).catch(() => {});
}

export const submitReview = (review: { rating: number; text: string; name: string; streak: number }) =>
  post<{ ok: true }>("/api/reviews", review);

export interface PayConfig {
  paypal: boolean;
  paypalClientId: string;
  sandbox: boolean;
  mpesa: boolean;
  kesPerUsd: number;
}

export interface PaidOrder extends Licence {
  status: "paid";
  orderId: string;
  paid: number;
  currency: string;
}

export type MpesaPoll = PaidOrder | { status: "pending" } | { status: "failed"; message?: string };

export interface OrderInput {
  plan: string;
  coupon: string | null;
  email: string;
  name?: string;
}

export async function fetchPayConfig(): Promise<PayConfig | null> {
  try {
    const res = await fetch("/api/pay/config");
    return res.ok ? ((await res.json()) as PayConfig) : null;
  } catch {
    return null;
  }
}

export const createPayPalOrder = (order: OrderInput & { method: "paypal" | "card" }) =>
  post<{ id: string }>("/api/pay/paypal/create", { ...order });

/** A payment PayPal is holding for review; the licence is issued by webhook once it clears. */
export interface ReviewOrder {
  status: "pending";
  orderId: string;
  message: string;
}

export const capturePayPalOrder = (orderId: string) => post<PaidOrder | ReviewOrder>("/api/pay/paypal/capture", { orderId });

export const startMpesa = (order: OrderInput & { phone: string }) =>
  post<{ reference: string; amountKes: number }>("/api/pay/mpesa/start", { ...order });

export async function pollMpesa(reference: string): Promise<MpesaPoll> {
  const res = await fetch(`/api/pay/mpesa/status?reference=${encodeURIComponent(reference)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as MpesaPoll;
}

export const lookupLicence = (licence: string, email: string) =>
  post<Licence>("/api/licence", { licence, email });

export async function fetchRelease(): Promise<Release | null> {
  try {
    const res = await fetch("/api/release");
    return res.ok ? ((await res.json()) as Release) : null;
  } catch {
    return null;
  }
}

/** Latest published bot release, or null until it loads (or if the site API is unreachable). */
export function useRelease(): Release | null {
  const [release, setRelease] = useState<Release | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchRelease().then((r) => alive && setRelease(r));
    return () => {
      alive = false;
    };
  }, []);
  return release;
}

/** The licence saved on this device, kept in sync across components. */
export function useLicence(): Licence | null {
  const [licence, setLicence] = useState(loadLicence);
  useEffect(() => {
    const sync = () => setLicence(loadLicence());
    window.addEventListener(LICENCE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(LICENCE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return licence;
}

export function loadLicence(): Licence | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LICENCE_KEY) ?? "null");
    return raw && typeof raw.licence === "string" ? raw : null;
  } catch {
    return null;
  }
}

export function saveLicence(licence: Licence) {
  try {
    localStorage.setItem(LICENCE_KEY, JSON.stringify(licence));
  } catch {
    /* storage blocked */
  }
  window.dispatchEvent(new Event(LICENCE_EVENT));
}

export function compareVersions(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
