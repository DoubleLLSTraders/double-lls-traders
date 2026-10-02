/**
 * Server-side payment providers, ported from the Kentunez setup:
 * PayPal REST (PayPal wallet and direct card) and PayHero M-Pesa STK push.
 * Credentials come from server environment variables and never reach the browser, except the public PayPal client id.
 */

const PAYHERO_API_URL = "https://backend.payhero.co.ke/api/v2";
const TIMEOUT_MS = 30_000;

export interface PaymentEnv {
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_ENV?: string;
  /** Id of the webhook registered in the PayPal developer dashboard, used to verify webhook signatures. */
  PAYPAL_WEBHOOK_ID?: string;
  PAYHERO_API_USERNAME?: string;
  PAYHERO_API_PASSWORD?: string;
  PAYHERO_BASIC_AUTH?: string;
  PAYHERO_BASIC_TOKEN?: string;
  PAYHERO_CHANNEL_ID?: string;
  SITE_URL?: string;
}

async function fetchJson(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || `HTTP ${res.status}` };
  }
  return { status: res.status, data };
}

/* ---------- PayPal ---------- */

export function paypalConfig(env: PaymentEnv) {
  const clientId = (env.PAYPAL_CLIENT_ID ?? "").trim();
  const secret = (env.PAYPAL_CLIENT_SECRET ?? "").trim();
  const sandbox = (env.PAYPAL_ENV ?? "").toLowerCase() === "sandbox";
  return {
    clientId,
    secret,
    sandbox,
    base: sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com",
    enabled: !!(clientId && secret),
  };
}

let paypalToken: { value: string; until: number } | null = null;

async function paypalApi(env: PaymentEnv, method: string, route: string, body?: unknown) {
  const cfg = paypalConfig(env);
  if (!cfg.enabled) throw Object.assign(new Error("PayPal is not set up yet."), { status: 503 });
  if (!paypalToken || paypalToken.until < Date.now()) {
    const tok = await fetchJson(`${cfg.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const access = tok.data.access_token;
    if (typeof access !== "string") throw Object.assign(new Error("PayPal rejected the credentials."), { status: 502 });
    paypalToken = { value: access, until: Date.now() + (Number(tok.data.expires_in) || 3000) * 1000 - 60_000 };
  }
  return fetchJson(`${cfg.base}${route}`, {
    method,
    headers: { Authorization: `Bearer ${paypalToken.value}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function createPayPalOrder(env: PaymentEnv, o: { reference: string; description: string; totalUsd: number }) {
  const res = await paypalApi(env, "POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: o.reference,
        description: o.description.slice(0, 127),
        amount: { currency_code: "USD", value: o.totalUsd.toFixed(2) },
      },
    ],
    application_context: { shipping_preference: "NO_SHIPPING", brand_name: "Double LLS Trading Bot" },
  });
  const id = res.data.id;
  if (res.status >= 300 || typeof id !== "string") throw Object.assign(new Error("PayPal could not create the order."), { status: 502 });
  return id;
}

interface PayPalCapture {
  status?: string;
  purchase_units?: { reference_id?: string; payments?: { captures?: { id?: string; status?: string; amount?: { value?: string; currency_code?: string } }[] } }[];
  payer?: { email_address?: string; name?: { given_name?: string; surname?: string } };
  details?: { issue?: string }[];
}

/** Captures the order (or reads it back if it was already captured) and returns what was actually paid. */
export async function capturePayPalOrder(env: PaymentEnv, orderId: string) {
  const id = encodeURIComponent(orderId);
  let res = await paypalApi(env, "POST", `/v2/checkout/orders/${id}/capture`, {});
  const first = res.data as PayPalCapture;
  if (res.status >= 300 && (first.details ?? []).some((d) => d.issue === "ORDER_ALREADY_CAPTURED")) {
    res = await paypalApi(env, "GET", `/v2/checkout/orders/${id}`);
  }
  const order = res.data as PayPalCapture;
  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  const paid = order.status === "COMPLETED" && capture?.status === "COMPLETED";
  return {
    paid,
    /** PayPal took the payment but is holding it for review; PAYMENT.CAPTURE.COMPLETED arrives by webhook later. */
    pending: capture?.status === "PENDING",
    reference: unit?.reference_id ?? "",
    captureId: capture?.id ?? "",
    amount: Number(capture?.amount?.value ?? 0),
    currency: capture?.amount?.currency_code ?? "",
    payerEmail: order.payer?.email_address ?? "",
    payerName: [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(" "),
  };
}

export interface PayPalWebhookEvent {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;
    status?: string;
    amount?: { value?: string; currency_code?: string };
    supplementary_data?: { related_ids?: { order_id?: string } };
    links?: { href?: string; rel?: string }[];
  };
}

/** Asks PayPal whether a webhook delivery is genuine. Unverifiable deliveries must be ignored. */
export async function verifyPayPalWebhook(env: PaymentEnv, headers: Headers, event: PayPalWebhookEvent) {
  const webhookId = (env.PAYPAL_WEBHOOK_ID ?? "").trim();
  if (!webhookId) return false;
  const h = (name: string) => headers.get(name) ?? "";
  const res = await paypalApi(env, "POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: h("paypal-auth-algo"),
    cert_url: h("paypal-cert-url"),
    transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"),
    transmission_time: h("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: event,
  });
  return res.status < 300 && res.data.verification_status === "SUCCESS";
}

/* ---------- PayHero M-Pesa ---------- */

const asBasic = (t?: string) => {
  const v = (t ?? "").trim();
  return v ? (v.startsWith("Basic ") ? v : `Basic ${v}`) : "";
};

/** Every configured PayHero credential, in the order Kentunez tries them. */
function payheroAuths(env: PaymentEnv) {
  const user = (env.PAYHERO_API_USERNAME ?? "").trim();
  const pass = (env.PAYHERO_API_PASSWORD ?? "").trim();
  const list = [
    user && pass ? `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` : "",
    asBasic(env.PAYHERO_BASIC_AUTH),
    asBasic(env.PAYHERO_BASIC_TOKEN),
  ].filter(Boolean);
  return [...new Set(list)];
}

let payheroWorking = "";

/** Calls PayHero, falling back to the next credential when one is rejected, and remembers the one that works. */
async function payheroFetch(env: PaymentEnv, url: string, init: RequestInit) {
  const auths = payheroAuths(env);
  if (!auths.length) throw Object.assign(new Error("M-Pesa is not set up yet."), { status: 503 });
  const ordered = auths.includes(payheroWorking) ? [payheroWorking, ...auths.filter((a) => a !== payheroWorking)] : auths;
  let res = { status: 401, data: {} as Record<string, unknown> };
  for (const auth of ordered) {
    res = await fetchJson(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: auth } });
    if (res.status !== 401 && res.status !== 403) {
      payheroWorking = auth;
      break;
    }
  }
  return res;
}

export const mpesaEnabled = (env: PaymentEnv) => payheroAuths(env).length > 0;

/** 07XXXXXXXX / 01XXXXXXXX, the format PayHero expects. */
export function normalizeKenyanPhone(raw: string) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length >= 12) return `0${digits.slice(3, 12)}`;
  if (digits.startsWith("0") && digits.length >= 10) return digits.slice(0, 10);
  if (digits.length >= 9) return `0${digits.slice(-9)}`;
  return "";
}

function payheroError(data: Record<string, unknown>, status: number) {
  if (status === 401) return "M-Pesa is not available right now.";
  const msg = data.error_message ?? data.message ?? data.error;
  return typeof msg === "string" && msg ? msg : `M-Pesa request failed (${status}).`;
}

export async function startStkPush(env: PaymentEnv, o: { phone: string; amountKes: number; externalReference: string; customerName?: string; callbackUrl: string }) {
  const res = await payheroFetch(env, `${PAYHERO_API_URL}/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: Math.round(o.amountKes),
      phone_number: o.phone,
      channel_id: Number(env.PAYHERO_CHANNEL_ID) || 8561,
      provider: "m-pesa",
      external_reference: o.externalReference,
      callback_url: o.callbackUrl,
      ...(o.customerName ? { customer_name: o.customerName } : {}),
    }),
  });
  const d = res.data;
  const queued = res.status === 201 || d.success === true || String(d.status ?? "").toUpperCase() === "QUEUED";
  const reference = String(d.reference ?? "");
  if (!queued || !reference) throw Object.assign(new Error(payheroError(d, res.status)), { status: res.status >= 400 && res.status < 500 ? 400 : 502 });
  return { reference, checkoutRequestId: String(d.CheckoutRequestID ?? "") };
}

export type MpesaStatus = "pending" | "paid" | "failed";

export async function stkStatus(env: PaymentEnv, reference: string): Promise<{ status: MpesaStatus; receipt: string; amount: number; message: string }> {
  const res = await payheroFetch(env, `${PAYHERO_API_URL}/transaction-status?reference=${encodeURIComponent(reference)}`, { method: "GET" });
  if (res.status === 404) return { status: "pending", receipt: "", amount: 0, message: "" };
  if (res.status >= 500 || res.status === 401 || res.status === 403) throw Object.assign(new Error(payheroError(res.data, res.status)), { status: 502 });
  const d = res.data;
  const st = String(d.status ?? d.Status ?? "").toUpperCase();
  const receipt = String(d.provider_reference ?? d.MpesaReceiptNumber ?? d.third_party_reference ?? "");
  const paid = st === "SUCCESS" || (d.success === true && !!receipt);
  return {
    status: paid ? "paid" : st === "FAILED" ? "failed" : "pending",
    receipt,
    amount: Number(d.amount ?? d.Amount ?? 0),
    message: String(d.ResultDesc ?? d.message ?? ""),
  };
}
