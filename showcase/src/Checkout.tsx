import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "./account";
import { MODES, type BotSettings } from "./bot";
import { BOT_NAME, type ExportFormat } from "./exports";
import { symbolName } from "./market";
import { PayPalButton } from "./PayPalButton";
import { COUPONS, PLAN_PRICES, quote, type PlanId } from "./pricing";
import { LicenceFiles } from "./Purchase";
import {
  capturePayPalOrder,
  createPayPalOrder,
  fetchPayConfig,
  pollMpesa,
  saveLicence,
  startMpesa,
  type PaidOrder,
  type PayConfig,
} from "./siteClient";

type PayMethod = "card" | "paypal" | "mpesa";

interface Plan {
  id: PlanId;
  was?: number;
  setup: string;
  /** What happens after payment for the setup part of the order. */
  setupNext: string;
  tagline: string;
  perks: string[];
  badge?: string;
}

const ALL_FORMATS: ExportFormat[] = ["dbot-xml", "javascript", "python", "json"];
const MPESA_POLL_MS = 3000;
const MPESA_TIMEOUT_MS = 150_000;

const PLANS: Plan[] = [
  {
    id: "lite",
    setup: "Guided setup",
    setupNext: "Your step-by-step setup video and a settings check are in your inbox. Reply to that email if anything doesn't run.",
    tagline: "Every format, set it up yourself",
    perks: ["All 4 formats: Deriv Bot, JS, Python, JSON", "Full engine, all contract types", "3 months of updates", "Email support"],
  },
  {
    id: "pro",
    was: 199,
    setup: "Live setup call",
    setupNext: "We'll email you within 24 hours to book a live call. We connect the bot to your Deriv account and test it with you.",
    tagline: "We set it up with you",
    perks: ["Everything in Starter", "Live setup call on your account", "12 months of updates", "Priority support"],
    badge: "Most popular",
  },
  {
    id: "lifetime",
    setup: "Done-for-you install",
    setupNext: "We'll email you within 24 hours. We install the bot on your PC or a VPS so it runs 24/7, then walk you through it.",
    tagline: "Installed for you, runs 24/7",
    perks: ["Everything in Pro", "Install on your PC or VPS", "Lifetime updates", "1-on-1 strategy session"],
  },
];

const METHOD_LABEL: Record<PayMethod, string> = { card: "Card", paypal: "PayPal", mpesa: "M-Pesa" };

const usd = (n: number) => `$${n.toFixed(2)}`;
const kes = (n: number) => `KES ${n.toLocaleString("en-US")}`;
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

interface CheckoutProps {
  settings: BotSettings;
  onSettings: (next: BotSettings) => void;
  onBack: () => void;
}

export function Checkout({ settings, onSettings, onBack }: CheckoutProps) {
  const [planId, setPlanId] = useState<PlanId>("pro");
  const [method, setMethod] = useState<PayMethod>("card");
  const account = useAccount();
  const email = account?.email ?? "";
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<string | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [config, setConfig] = useState<PayConfig | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [paid, setPaid] = useState<(PaidOrder & { method: PayMethod; amount: string }) | null>(null);
  const [phone, setPhone] = useState("");
  const [mpesaName, setMpesaName] = useState("");
  const [mpesaWaiting, setMpesaWaiting] = useState<{ reference: string; amountKes: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const plan = PLANS.find((p) => p.id === planId)!;
  const q = useMemo(() => quote(planId, coupon)!, [planId, coupon]);
  const price = PLAN_PRICES[planId];
  const emailError = touched && !validEmail(email) ? "Enter a valid email for your licence" : null;

  const orderRef = useRef({ plan: planId, coupon, email });
  orderRef.current = { plan: planId, coupon, email: email.trim() };

  useEffect(() => {
    void fetchPayConfig().then(setConfig);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [paid]);

  useEffect(() => {
    if (!mpesaWaiting) return;
    let stopped = false;
    const started = Date.now();
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await pollMpesa(mpesaWaiting.reference);
        if (stopped) return;
        if (r.status === "paid") return finish(r, "mpesa");
        if (r.status === "failed") {
          setMpesaWaiting(null);
          setPayError(r.message || "The M-Pesa payment was cancelled. Try again.");
          return;
        }
      } catch {
        /* network blip; keep polling */
      }
      if (Date.now() - started > MPESA_TIMEOUT_MS) {
        setMpesaWaiting(null);
        setPayError("We didn't get a confirmation from M-Pesa. If money left your account, contact support with your M-Pesa message.");
        return;
      }
      window.setTimeout(tick, MPESA_POLL_MS);
    };
    const id = window.setTimeout(tick, MPESA_POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(id);
    };
  }, [mpesaWaiting]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyCoupon = () => {
    const code = couponInput.trim().toUpperCase();
    if (COUPONS[code]) {
      setCoupon(code);
      setCouponError(null);
    } else {
      setCoupon(null);
      setCouponError("That code isn't valid");
    }
  };

  function finish(order: PaidOrder, how: PayMethod) {
    saveLicence({ licence: order.licence, plan: order.plan, email: order.email, version: order.version });
    setMpesaWaiting(null);
    setPayError(null);
    setPaid({ ...order, method: how, amount: order.currency === "KES" ? kes(order.paid) : usd(order.paid) });
  }

  const checkEmail = () => {
    setTouched(true);
    if (validEmail(email.trim())) return true;
    setPayError("Sign in to your account to purchase.");
    return false;
  };

  const payMpesa = async () => {
    setPayError(null);
    if (!checkEmail()) return;
    setBusy(true);
    try {
      const r = await startMpesa({ ...orderRef.current, phone, name: mpesaName.trim() });
      setMpesaWaiting(r);
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "M-Pesa could not start. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const chooseMethod = (m: PayMethod) => {
    if (mpesaWaiting) return;
    setMethod(m);
    setPayError(null);
  };

  const paypalReady = !!config?.paypal && !!config.paypalClientId;

  return (
    <div className="co">
      <div className="co-glow" />
      <nav className="co-nav">
        <button className="btn ghost" onClick={onBack}>‹ Back</button>
        <span className="wordmark">DOUBLE LLS<span>TRADING BOT</span></span>
        <span className="co-secure"><LockIcon /> Secure checkout</span>
      </nav>

      <ol className="co-steps">
        {["Plan", "Payment", "Download"].map((s, i) => {
          const at = paid ? 2 : 1;
          return (
            <li key={s} className={i < at ? "done" : i === at ? "on" : ""}>
              <i>{i < at ? "✓" : i + 1}</i>{s}
            </li>
          );
        })}
      </ol>

      {paid ? (
        <section className="co-success">
          <div className="co-check"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" /><path d="M15 27l7 7 15-16" /></svg></div>
          <h1>You're in.</h1>
          <p>
            {BOT_NAME} · {paid.plan} licence is active. Your licence key and receipt go to <strong>{paid.email}</strong>.
          </p>
          <div className="co-receipt">
            <span>Order <strong>{paid.orderId}</strong></span>
            <span>Licence key <strong>{paid.licence}</strong></span>
            <span>Paid <strong>{paid.amount}</strong></span>
            <span>{METHOD_LABEL[paid.method]}</span>
          </div>
          <div className="co-card co-next">
            <header className="pane-head"><span>Setup · {plan.setup}</span><span className="co-paid">Paid</span></header>
            <div className="pane-body"><p>{plan.setupNext}</p></div>
          </div>
          <div className="co-card co-files">
            <header className="pane-head"><span>Your files</span></header>
            <div className="pane-body">
              <LicenceFiles settings={settings} onSettings={onSettings} formats={ALL_FORMATS} />
            </div>
          </div>
        </section>
      ) : (
        <div className="co-grid">
          <div className="co-main">
            <section className="co-block">
              <h2><span>01</span> Choose your licence</h2>
              <div className="co-plans">
                {PLANS.map((p) => {
                  const pp = PLAN_PRICES[p.id];
                  return (
                    <button
                      key={p.id}
                      className={`co-plan ${p.id === planId ? "on" : ""}`}
                      onClick={() => !mpesaWaiting && setPlanId(p.id)}
                      type="button"
                    >
                      {p.badge && <span className="co-badge">{p.badge}</span>}
                      <span className="co-radio" />
                      <strong>{pp.name}</strong>
                      <span className="co-tag">{p.tagline}</span>
                      <span className="co-price">
                        ${pp.price}
                        {p.was && <s>${p.was}</s>}
                      </span>
                      <span className="co-setup">+ ${pp.setupFee} setup · {p.setup}</span>
                      <ul>{p.perks.map((x) => <li key={x}>{x}</li>)}</ul>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="co-block">
              <h2><span>02</span> Account</h2>
              {account ? (
                <div className="co-account">
                  <span className="acct-btn-avatar">{(account.name || account.email)[0].toUpperCase()}</span>
                  <div>
                    <strong>{account.name || account.email}</strong>
                    <span>{account.name ? `${account.email} · ` : ""}Licence and receipt are saved to this account.</span>
                  </div>
                  <a className="btn ghost sm" href="#/account">Change</a>
                </div>
              ) : (
                <div className="co-account out">
                  <span>Sign in to purchase. Your licence is saved to your account.</span>
                  <a className="btn solid sm" href="#/account">Sign in</a>
                </div>
              )}
              {emailError && <span className="co-err">{emailError}</span>}
            </section>

            <section className="co-block">
              <h2><span>03</span> Payment</h2>
              <div className="co-tabs co-tabs-3">
                {(["card", "paypal", "mpesa"] as const).map((m) => (
                  <button key={m} className={method === m ? "on" : ""} onClick={() => chooseMethod(m)}>
                    <PayIcon method={m} />
                    {m === "card" ? "Debit / credit card" : METHOD_LABEL[m]}
                  </button>
                ))}
              </div>

              {method === "mpesa" ? (
                <div className="co-method">
                  {mpesaWaiting ? (
                    <div className="co-mpesa-wait">
                      <span className="co-spin big" />
                      <strong>Check your phone</strong>
                      <p>Enter your M-Pesa PIN to pay <b>{kes(mpesaWaiting.amountKes)}</b>. This page updates by itself once it goes through.</p>
                      <button className="btn ghost sm" onClick={() => setMpesaWaiting(null)}>Cancel</button>
                    </div>
                  ) : (
                    <>
                      <p className="co-method-note">We send an M-Pesa prompt to your phone. Enter your PIN to pay {kes(q.totalKes)}.</p>
                      <div className="co-row">
                        <label className="co-field">
                          <span>Safaricom number</span>
                          <input inputMode="tel" autoComplete="tel" placeholder="0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
                        </label>
                        <label className="co-field">
                          <span>Name (optional)</span>
                          <input autoComplete="name" placeholder="Jane Wanjiku" value={mpesaName} onChange={(e) => setMpesaName(e.target.value)} />
                        </label>
                      </div>
                      <button className="btn lg co-mpesa-btn" onClick={payMpesa} disabled={busy || !config?.mpesa}>
                        {busy ? <><span className="co-spin" /> Sending prompt…</> : <>Pay {kes(q.totalKes)} with M-Pesa</>}
                      </button>
                      {config && !config.mpesa && <p className="co-method-off">M-Pesa isn't switched on yet.</p>}
                    </>
                  )}
                </div>
              ) : (
                <div className="co-method">
                  <p className="co-method-note">
                    {method === "card"
                      ? "Pay with Visa, Mastercard or Amex. Your card is processed securely by PayPal; no PayPal account needed."
                      : "You'll be taken to PayPal to log in and approve the payment, then brought straight back here."}
                  </p>
                  {paypalReady ? (
                    <PayPalButton
                      key={method}
                      clientId={config.paypalClientId}
                      fundingSource={method}
                      onClick={checkEmail}
                      createOrder={async () => {
                        setPayError(null);
                        const { id } = await createPayPalOrder({ ...orderRef.current, method: method as "card" | "paypal" });
                        return id;
                      }}
                      onApprove={async (orderId) => {
                        finish(await capturePayPalOrder(orderId), method);
                      }}
                      onError={(message) => setPayError(message)}
                    />
                  ) : (
                    <p className="co-method-off">{config ? "Card and PayPal payments aren't switched on yet." : "Loading payment options…"}</p>
                  )}
                </div>
              )}
              {payError && <p className="co-err co-pay-err">{payError}</p>}
            </section>
          </div>

          <aside className="co-side">
            <div className="co-card">
              <header className="pane-head"><span>Order summary</span></header>
              <div className="pane-body">
                <div className="co-line big">
                  <span>{BOT_NAME}<em>{price.name} licence + {plan.setup.toLowerCase()}</em></span>
                  <strong>{usd(price.price + price.setupFee)}</strong>
                </div>
                <dl className="co-config">
                  <div><dt>Mode</dt><dd>{MODES.find((m) => m.id === settings.mode)?.label}</dd></div>
                  <div><dt>Stake</dt><dd>{usd(settings.stake)}</dd></div>
                  <div><dt>Symbol</dt><dd>{symbolName(settings.symbol)}</dd></div>
                </dl>

                <div className="co-coupon">
                  <input
                    placeholder="Discount code"
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && applyCoupon()}
                    disabled={!!mpesaWaiting}
                  />
                  <button className="btn outline sm" onClick={applyCoupon} disabled={!!mpesaWaiting}>Apply</button>
                </div>
                {couponError && <span className="co-err">{couponError}</span>}

                <div className="co-line"><span>Licence</span><span>{usd(price.price)}</span></div>
                <div className="co-line"><span>Setup fee · {plan.setup}<em>One-time</em></span><span>{usd(price.setupFee)}</span></div>
                {q.coupon && (
                  <div className="co-line up">
                    <span>{q.coupon} · {COUPONS[q.coupon] * 100}% off licence</span><span>−{usd(q.discount)}</span>
                  </div>
                )}
                <div className="co-line total"><span>Total</span><strong>{usd(q.total)}</strong></div>
                {method === "mpesa" && <div className="co-line"><span>On M-Pesa</span><span>{kes(q.totalKes)}</span></div>}

                <ul className="co-trust">
                  <li>Pay by card, PayPal or M-Pesa</li>
                  <li>Instant download, every format</li>
                  <li>Runs on phone, PC, Mac, Linux or VPS</li>
                  <li>7-day money-back guarantee</li>
                  <li>We never see or store your card details</li>
                </ul>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function PayIcon({ method }: { method: PayMethod }) {
  if (method === "card") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="M3 10h18M7 15h4" /></svg>
    );
  }
  if (method === "paypal") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20l1.2-7h3.3c3.3 0 5.3-1.7 5.8-4.6.4-2.6-1.4-4.4-4.6-4.4H8.6L6 20h2z" /><path d="M10 9h3" /></svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.2" /><path d="M11 18.5h2" /></svg>
  );
}

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
