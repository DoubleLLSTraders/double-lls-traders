import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BotAvatar } from "./BotAvatar";

const KEY_STORAGE = "double-lls:admin-session";
const POLL_MS = 4000;
const NOW_MS = 1000;

type Tab = "overview" | "live" | "reviews" | "purchases" | "installs" | "updates" | "activity";

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

interface LiveRow {
  visitorId: string;
  page: string;
  since: number;
  lastSeen: number;
  bot: { running: boolean; balance: number; startBalance: number; pnl: number; trades: number; winRate: number; mode: string; speed: number } | null;
  visitor: Visitor | null;
}

interface Review { id: string; at: number; visitorId: string; rating: number; text: string; name: string; streak: number; hidden: boolean }
interface Purchase {
  orderId: string; at: number; licence: string; plan: string; email: string; name: string; method: string; coupon: string;
  licencePrice: number; setupFee: number; total: number; version: string; paid?: number; currency?: string; paymentRef?: string; phone?: string;
}

const METHOD_NAMES: Record<string, string> = { card: "Card", paypal: "PayPal", mpesa: "M-Pesa" };
const paidLabel = (p: Purchase) =>
  p.currency === "KES" ? `KES ${Math.round(p.paid ?? 0).toLocaleString("en-US")}` : usd(p.paid ?? p.total);
interface Install { licence: string; format: string; version: string; firstSeen: number; lastSeen: number; runs: number }
interface Release { version: string; notes: string; at: number }
interface SiteEvent { at: number; visitorId: string; type: string; detail?: string }

interface Overview {
  now: number;
  release: Release;
  releases: Release[];
  totals: {
    live: number; liveTesting: number; visitors: number; visitorsToday: number; testers: number; testClicks: number;
    purchases: number; revenue: number; reviews: number; rating: number; installs: number; activeInstalls: number; outdated: number;
  };
  days: { day: number; visitors: number; testers: number; purchases: number }[];
  live: LiveRow[];
  reviews: Review[];
  purchases: Purchase[];
  installs: Install[];
  visitors: Visitor[];
  events: SiteEvent[];
}

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "live", label: "Live now" },
  { id: "reviews", label: "Reviews" },
  { id: "purchases", label: "Purchases" },
  { id: "installs", label: "Bot users" },
  { id: "updates", label: "Updates" },
  { id: "activity", label: "Activity" },
];

const EVENT_LABELS: Record<string, string> = {
  visit: "Opened the site",
  test_click: "Clicked Test the bot",
  bot_start: "Started the bot",
  checkout_open: "Opened checkout",
  purchase: "Purchased",
  download: "Downloaded",
  review: "Left a review",
  licence_open: "Opened their licence",
};

const PAGE_LABELS: Record<string, string> = { landing: "Home page", test: "Testing the bot", checkout: "Checkout", licence: "Licence page" };

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}`;
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function ago(t: number, now: number) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const who = (v: Visitor | null | undefined, id: string) => v?.name || v?.email || `Visitor ${id.slice(2, 8)}`;

function Stars({ n }: { n: number }) {
  return (
    <span className="adm-stars" aria-label={`${n} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= n ? "on" : ""}>★</i>)}
    </span>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "live" }) {
  return (
    <div className="adm-kpi">
      <label>{tone === "live" && <span className="adm-dot" />}{label}</label>
      <strong className={tone === "up" ? "up" : ""}>{value}</strong>
      {sub && <span>{sub}</span>}
    </div>
  );
}

async function api<T>(key: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "x-admin-key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error ?? `Request failed (${res.status})`), { status: res.status });
  return data as T;
}

export default function Admin() {
  const [key, setKey] = useState(() => localStorage.getItem(KEY_STORAGE) ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async (k: string) => {
    try {
      const d = await api<Overview>(k, "/api/admin/overview");
      setData(d);
      setError(null);
      return true;
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 401 || e.status === 429 || e.status === 503) {
        localStorage.removeItem(KEY_STORAGE);
        setKey("");
        setData(null);
      }
      setError(e.message);
      return false;
    }
  }, []);

  useEffect(() => {
    document.title = "Double LLS · Admin";
    if (!key) return;
    void load(key);
    const id = setInterval(() => void load(key), POLL_MS);
    return () => clearInterval(id);
  }, [key, load]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_MS);
    return () => clearInterval(id);
  }, []);

  const login = async () => {
    setSigningIn(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const d = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !d.token) throw new Error(d.error ?? `Sign-in failed (${res.status})`);
      if (await load(d.token)) {
        localStorage.setItem(KEY_STORAGE, d.token);
        setKey(d.token);
        setPassword("");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSigningIn(false);
    }
  };

  const logout = () => {
    localStorage.removeItem(KEY_STORAGE);
    setKey("");
    setData(null);
  };

  if (!key || !data) {
    return (
      <div className="adm-login">
        <form
          className="adm-login-card"
          onSubmit={(e) => {
            e.preventDefault();
            void login();
          }}
        >
          <BotAvatar size={72} />
          <h1>Admin</h1>
          <p>Double LLS Trading Bot</p>
          <input type="email" autoFocus autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <span className="co-err">{error}</span>}
          <button className="btn solid lg" disabled={!email.trim() || !password || signingIn}>{signingIn ? "Signing in…" : "Sign in"}</button>
        </form>
      </div>
    );
  }

  const run = async (path: string, body: unknown) => {
    try {
      setData(await api<Overview>(key, path, body));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const t = data.totals;
  return (
    <div className="adm">
      <aside className="adm-side">
        <div className="adm-brand"><BotAvatar size={28} /> Double LLS <em>Admin</em></div>
        <nav>
          {TABS.map((x) => (
            <button key={x.id} className={tab === x.id ? "on" : ""} onClick={() => setTab(x.id)}>
              {x.label}
              {x.id === "live" && t.live > 0 && <em className="live">{t.live}</em>}
              {x.id === "reviews" && <em>{data.reviews.length}</em>}
              {x.id === "purchases" && <em>{t.purchases}</em>}
              {x.id === "installs" && t.outdated > 0 && <em className="warn">{t.outdated}</em>}
            </button>
          ))}
        </nav>
        <div className="adm-side-foot">
          <span className="muted">Bot v{data.release.version} · updates every {POLL_MS / 1000}s</span>
          <button className="btn ghost sm" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <main className="adm-main">
        {error && <p className="notice">{error}</p>}

        {tab === "overview" && (
          <>
            <header className="adm-head"><h1>Overview</h1><p>Everyone who visits, tests, buys and runs the bot.</p></header>
            <div className="adm-kpis">
              <Kpi label="Live now" value={String(t.live)} sub={`${t.liveTesting} testing the bot`} tone="live" />
              <Kpi label="Visitors" value={t.visitors.toLocaleString()} sub={`${t.visitorsToday} today`} />
              <Kpi label="Tested the bot" value={t.testers.toLocaleString()} sub={`${t.testClicks} test clicks`} />
              <Kpi label="Purchases" value={t.purchases.toLocaleString()} sub={t.visitors ? `${((t.purchases / t.visitors) * 100).toFixed(1)}% of visitors` : undefined} />
              <Kpi label="Revenue" value={usd(t.revenue)} tone="up" />
              <Kpi label="Rating" value={t.reviews ? t.rating.toFixed(1) : "—"} sub={`${t.reviews} reviews`} />
              <Kpi label="Bots running" value={String(t.activeInstalls)} sub={`${t.installs} installs seen`} />
              <Kpi label="Need update" value={String(t.outdated)} sub={`latest v${data.release.version}`} />
            </div>
            <section className="adm-card">
              <header><span>Last 14 days</span><span className="adm-legend"><i className="a" />Visitors <i className="b" />Testers <i className="c" />Purchases</span></header>
              <div className="adm-bars">
                {data.days.map((d) => {
                  const max = Math.max(1, ...data.days.map((x) => x.visitors));
                  return (
                    <div key={d.day} title={`${new Date(d.day).toLocaleDateString()}: ${d.visitors} visitors, ${d.testers} testers, ${d.purchases} purchases`}>
                      <div className="adm-bar-stack">
                        <i className="a" style={{ height: `${(d.visitors / max) * 100}%` }} />
                        <i className="b" style={{ height: `${(d.testers / max) * 100}%` }} />
                        <i className="c" style={{ height: `${(d.purchases / max) * 100}%` }} />
                      </div>
                      <span>{new Date(d.day).toLocaleDateString(undefined, { day: "numeric" })}</span>
                    </div>
                  );
                })}
              </div>
            </section>
            <div className="adm-split">
              <section className="adm-card">
                <header><span>Latest reviews</span><button className="btn ghost sm" onClick={() => setTab("reviews")}>All</button></header>
                {data.reviews.slice(0, 4).map((r) => <ReviewItem key={r.id} r={r} now={now} />)}
                {!data.reviews.length && <p className="adm-empty">No reviews yet.</p>}
              </section>
              <section className="adm-card">
                <header><span>Latest activity</span><button className="btn ghost sm" onClick={() => setTab("activity")}>All</button></header>
                <EventList events={data.events.slice(0, 8)} visitors={data.visitors} now={now} />
              </section>
            </div>
          </>
        )}

        {tab === "live" && (
          <>
            <header className="adm-head"><h1>Live now</h1><p>People on the site right now. Testers show their bot as it runs.</p></header>
            {data.live.length ? (
              <div className="adm-live">
                {data.live.map((p) => (
                  <article key={p.visitorId} className="adm-live-card">
                    <header>
                      <span className="adm-dot" />
                      <strong>{who(p.visitor, p.visitorId)}</strong>
                      <span className="muted">{p.visitor?.device} · {duration(now - p.since)}</span>
                    </header>
                    <span className="adm-page">{PAGE_LABELS[p.page] ?? p.page}</span>
                    {p.bot && (
                      <dl>
                        <div><dt>Bot</dt><dd className={p.bot.running ? "up" : "muted"}>{p.bot.running ? "Trading" : "Stopped"}</dd></div>
                        <div><dt>Balance</dt><dd>{usd(p.bot.balance)}</dd></div>
                        <div><dt>P/L</dt><dd className={p.bot.pnl >= 0 ? "up" : "down"}>{signed(p.bot.pnl)}</dd></div>
                        <div><dt>Trades</dt><dd>{p.bot.trades}</dd></div>
                        <div><dt>Win rate</dt><dd>{p.bot.winRate.toFixed(1)}%</dd></div>
                        <div><dt>Mode</dt><dd>{p.bot.mode} · {p.bot.speed}×</dd></div>
                      </dl>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <p className="adm-empty big">Nobody is on the site right now.</p>
            )}
          </>
        )}

        {tab === "reviews" && (
          <>
            <header className="adm-head">
              <h1>Reviews</h1>
              <p>{t.reviews ? `${t.rating.toFixed(1)} average from ${t.reviews} visible reviews.` : "Reviews appear here as users leave them."}</p>
            </header>
            <section className="adm-card">
              {data.reviews.map((r) => (
                <ReviewItem key={r.id} r={r} now={now}>
                  <button className="btn ghost sm" onClick={() => run("/api/admin/review", { id: r.id, action: r.hidden ? "show" : "hide" })}>{r.hidden ? "Show" : "Hide"}</button>
                  <button
                    className="btn ghost sm danger"
                    onClick={() => confirm("Delete this review for good?") && run("/api/admin/review", { id: r.id, action: "delete" })}
                  >
                    Delete
                  </button>
                </ReviewItem>
              ))}
              {!data.reviews.length && <p className="adm-empty">No reviews yet.</p>}
            </section>
          </>
        )}

        {tab === "purchases" && (
          <>
            <header className="adm-head"><h1>Purchases</h1><p>{t.purchases} orders · {usd(t.revenue)} total.</p></header>
            <section className="adm-card flush">
              <div className="adm-scroll">
                <table className="adm-tbl">
                  <thead><tr><th>Date</th><th>Customer</th><th>Plan</th><th>Licence key</th><th>Paid with</th><th className="num">Licence</th><th className="num">Setup</th><th className="num">Total</th><th className="num">Received</th><th>Version</th></tr></thead>
                  <tbody>
                    {data.purchases.map((p) => (
                      <tr key={p.orderId + p.at}>
                        <td>{when(p.at)}</td>
                        <td><strong>{p.name || p.email}</strong>{p.name && <span>{p.email}</span>}</td>
                        <td>{p.plan}{p.coupon && <span>{p.coupon}</span>}</td>
                        <td className="mono">{p.licence}</td>
                        <td>{METHOD_NAMES[p.method] ?? p.method}{(p.paymentRef || p.phone) && <span className="mono">{p.paymentRef}{p.phone ? ` · ${p.phone}` : ""}</span>}</td>
                        <td className="num">{usd(p.licencePrice)}</td>
                        <td className="num">{usd(p.setupFee)}</td>
                        <td className="num">{usd(p.total)}</td>
                        <td className="num up">{paidLabel(p)}</td>
                        <td>v{p.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.purchases.length && <p className="adm-empty">No purchases yet.</p>}
              </div>
            </section>
          </>
        )}

        {tab === "installs" && (
          <>
            <header className="adm-head">
              <h1>Bot users</h1>
              <p>Downloaded bots check in when they start. Anyone on an old version is told to update.</p>
            </header>
            <section className="adm-card flush">
              <div className="adm-scroll">
                <table className="adm-tbl">
                  <thead><tr><th>Customer</th><th>Licence</th><th>Format</th><th>Version</th><th className="num">Runs</th><th>First run</th><th>Last run</th></tr></thead>
                  <tbody>
                    {data.installs.map((i) => {
                      const buyer = data.purchases.find((p) => p.licence === i.licence);
                      const old = i.version !== data.release.version;
                      return (
                        <tr key={i.licence + i.format}>
                          <td><strong>{buyer?.name || buyer?.email || "Unknown"}</strong>{buyer?.name && <span>{buyer.email}</span>}</td>
                          <td className="mono">{i.licence}</td>
                          <td>{i.format === "javascript" ? "JavaScript" : i.format === "python" ? "Python" : i.format}</td>
                          <td><span className={`adm-ver ${old ? "old" : ""}`}>v{i.version}{old ? " · needs update" : " · latest"}</span></td>
                          <td className="num">{i.runs}</td>
                          <td>{when(i.firstSeen)}</td>
                          <td>{ago(i.lastSeen, now)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!data.installs.length && <p className="adm-empty">No downloaded bots have checked in yet.</p>}
              </div>
            </section>
          </>
        )}

        {tab === "updates" && <Updates data={data} onPublish={(version, notes) => run("/api/admin/release", { version, notes })} />}

        {tab === "activity" && (
          <>
            <header className="adm-head"><h1>Activity</h1><p>The latest {data.events.length} things people did, newest first.</p></header>
            <div className="adm-split wide">
              <section className="adm-card">
                <header><span>Events</span></header>
                <EventList events={data.events} visitors={data.visitors} now={now} />
              </section>
              <section className="adm-card flush">
                <header><span>Visitors</span><span className="muted">{t.visitors.toLocaleString()} total</span></header>
                <div className="adm-scroll">
                  <table className="adm-tbl">
                    <thead><tr><th>Visitor</th><th>Device</th><th className="num">Visits</th><th className="num">Tests</th><th>Last seen</th></tr></thead>
                    <tbody>
                      {data.visitors.map((v) => (
                        <tr key={v.id}>
                          <td><strong>{who(v, v.id)}</strong><span>{v.tz || v.lang}{v.referrer ? ` · from ${v.referrer.replace(/^https?:\/\//, "").slice(0, 30)}` : ""}</span></td>
                          <td>{v.device}</td>
                          <td className="num">{v.visits}</td>
                          <td className="num">{v.testClicks}</td>
                          <td>{ago(v.lastSeen, now)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function ReviewItem({ r, now, children }: { r: Review; now: number; children?: ReactNode }) {
  return (
    <div className={`adm-review ${r.hidden ? "hidden" : ""}`}>
      <div className="adm-review-top">
        <Stars n={r.rating} />
        <strong>{r.name || "Anonymous"}</strong>
        <span className="muted">{ago(r.at, now)}{r.streak ? ` · after ${r.streak} wins in a row` : ""}{r.hidden ? " · hidden" : ""}</span>
        {children && <span className="adm-review-actions">{children}</span>}
      </div>
      {r.text ? <p>{r.text}</p> : <p className="muted">No comment, stars only.</p>}
    </div>
  );
}

function EventList({ events, visitors, now }: { events: SiteEvent[]; visitors: Visitor[]; now: number }) {
  if (!events.length) return <p className="adm-empty">Nothing yet.</p>;
  const byId = new Map(visitors.map((v) => [v.id, v]));
  return (
    <ul className="adm-events">
      {events.map((e, i) => (
        <li key={`${e.at}-${i}`} data-type={e.type}>
          <i />
          <span><strong>{who(byId.get(e.visitorId), e.visitorId)}</strong> {(EVENT_LABELS[e.type] ?? e.type).toLowerCase()}{e.detail ? <em> · {e.detail}</em> : null}</span>
          <time>{ago(e.at, now)}</time>
        </li>
      ))}
    </ul>
  );
}

function Updates({ data, onPublish }: { data: Overview; onPublish: (version: string, notes: string) => Promise<void> }) {
  const [major, minor, patch] = data.release.version.split(".").map(Number);
  const [version, setVersion] = useState(`${major}.${minor}.${patch + 1}`);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const outdated = data.totals.outdated;

  useEffect(() => {
    setVersion(`${major}.${minor}.${patch + 1}`);
  }, [major, minor, patch]);

  const publish = async () => {
    if (!confirm(`Publish v${version}? Every user on an older version will be told to update.`)) return;
    setBusy(true);
    await onPublish(version, notes.trim());
    setNotes("");
    setBusy(false);
  };

  return (
    <>
      <header className="adm-head">
        <h1>Updates</h1>
        <p>Publish a new version and every buyer sees an update message, on the site and inside their running bot.</p>
      </header>
      <div className="adm-split">
        <section className="adm-card">
          <header><span>Publish an update</span><span className="muted">Current v{data.release.version}</span></header>
          <div className="adm-form">
            <label className="co-field">
              <span>New version</span>
              <input value={version} onChange={(e) => setVersion(e.target.value.trim())} placeholder="1.1.0" />
            </label>
            <label className="co-field">
              <span>What's new (users see this)</span>
              <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Faster recovery and a higher win rate on Over/Under." />
            </label>
            <button className="btn solid" onClick={publish} disabled={busy || !/^\d+\.\d+\.\d+$/.test(version)}>
              {busy ? "Publishing…" : `Publish v${version}`}
            </button>
            <p className="adm-note">
              Deploy the new bot code first, then publish. Buyers get the message the next time their bot starts and on the site,
              and new downloads are stamped v{version}. {outdated > 0 && `${outdated} install${outdated > 1 ? "s are" : " is"} on an older version right now.`}
            </p>
          </div>
        </section>
        <section className="adm-card">
          <header><span>Release history</span></header>
          <ul className="adm-releases">
            {data.releases.map((r, i) => (
              <li key={r.version}>
                <strong>v{r.version}</strong>
                {i === 0 && <em>Live</em>}
                <time>{when(r.at)}</time>
                <p>{r.notes || <span className="muted">No notes.</span>}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
