import { useEffect, useRef, useState, type FormEvent } from "react";
import { CloudBotCard } from "./CloudBotCard";
import {
  changePassword,
  deleteAccount,
  refreshAccount,
  emailVerifiedYet,
  refreshVerification,
  resendVerification,
  sendPasswordReset,
  signIn,
  signOut,
  signUp,
  syncNow,
  useAccount,
  useSyncStatus,
  type AccountLicence,
} from "./account";
import { ApiKeysCard } from "./ApiKeysCard";
import { ReceiptButton } from "./ReceiptButton";
import { HISTORY_EVENT, loadHistory } from "./sessionStore";
import { useLicence } from "./siteClient";

interface AccountPageProps {
  onTest: () => void;
  onBuy: () => void;
  /** Sent here from a Purchase button: checkout opens as soon as they sign in. */
  forPurchase?: boolean;
}

const usd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;

function LockGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function useHistory() {
  const [list, setList] = useState(loadHistory);
  useEffect(() => {
    const sync = () => setList(loadHistory());
    window.addEventListener(HISTORY_EVENT, sync);
    return () => window.removeEventListener(HISTORY_EVENT, sync);
  }, []);
  return list;
}

function ResetForm({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="co-card acct-card" onSubmit={submit}>
      <h1>Reset your password</h1>
      {sent ? (
        <>
          <p className="acct-sub">
            If <strong>{email.trim()}</strong> has an account, a reset link is on its way. Open it, choose a new password, then sign in here.
            Check your spam folder if it does not arrive in a minute.
          </p>
          <button type="button" className="btn solid lg acct-submit" onClick={onBack}>Back to sign in</button>
        </>
      ) : (
        <>
          <p className="acct-sub">Enter the email you signed up with and we will send you a link to choose a new password.</p>
          <label className="co-field">
            <span>Email</span>
            <input type="email" required autoFocus autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error && <span className="co-err">{error}</span>}
          <button className="btn solid lg acct-submit" disabled={busy || !email.trim()}>{busy ? "Sending…" : "Send reset link"}</button>
          <p className="acct-switch">
            Remembered it? <button type="button" onClick={onBack}>Sign in</button>
          </p>
        </>
      )}
    </form>
  );
}

function AuthForm({ forPurchase }: { forPurchase?: boolean }) {
  const [mode, setMode] = useState<"signup" | "signin" | "reset">("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signup = mode === "signup";

  if (mode === "reset") return <ResetForm initialEmail={email} onBack={() => { setMode("signin"); setError(null); }} />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (signup) await signUp({ email: email.trim(), password, name: name.trim(), acceptTerms: agree });
      else await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="co-card acct-card" onSubmit={submit}>
      <div className="acct-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={signup} className={signup ? "on" : ""} onClick={() => { setMode("signup"); setError(null); }}>Create account</button>
        <button type="button" role="tab" aria-selected={!signup} className={!signup ? "on" : ""} onClick={() => { setMode("signin"); setError(null); }}>Sign in</button>
      </div>
      {forPurchase && (
        <div className="acct-purchase-note">
          <LockGlyph />
          <span><strong>Sign in to purchase.</strong> Your licence and receipt are saved to your account, so you can always get them back.</span>
        </div>
      )}
      <h1>{signup ? "Create your free account" : "Welcome back"}</h1>
      <p className="acct-sub">
        {forPurchase
          ? signup ? "Takes a few seconds. Checkout opens right after." : "Checkout opens right after you sign in."
          : signup ? "Test the bot, keep every session and your settings, and pick up on any device." : "Sign in to get your sessions, settings and licence."}
      </p>

      {signup && (
        <label className="co-field">
          <span>Name (optional)</span>
          <input autoComplete="name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <label className="co-field">
        <span>Email</span>
        <input type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="co-field">
        <span>Password</span>
        <div className="acct-pass">
          <input
            type={show ? "text" : "password"}
            required
            minLength={signup ? 8 : undefined}
            autoComplete={signup ? "new-password" : "current-password"}
            placeholder={signup ? "At least 8 characters" : "Your password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="button" className="acct-show" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
        </div>
      </label>
      {!signup && (
        <button type="button" className="acct-forgot" onClick={() => { setMode("reset"); setError(null); }}>Forgot password?</button>
      )}
      {signup && (
        <label className="check acct-agree">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>I accept the <a href="#/terms">Terms</a> and <a href="#/privacy">Privacy Policy</a>.</span>
        </label>
      )}
      {error && <span className="co-err">{error}</span>}
      <button className="btn solid lg acct-submit" disabled={busy || !email.trim() || !password || (signup && !agree)}>
        {busy ? (signup ? "Creating…" : "Signing in…") : signup ? "Create account" : "Sign in"}
      </button>
      <p className="acct-switch">
        {signup ? "Already have an account? " : "New here? "}
        <button type="button" onClick={() => { setMode(signup ? "signin" : "signup"); setError(null); }}>{signup ? "Sign in" : "Create one"}</button>
      </p>
    </form>
  );
}

const RESEND_WAIT_S = 60;
const VERIFY_POLL_MS = 5_000;
/** After this long the banner checks less often, in case the tab is left open for hours. */
const VERIFY_FAST_FOR_MS = 10 * 60_000;
const VERIFY_SLOW_POLL_MS = 30_000;
const VERIFIED_NOTICE_MS = 8_000;

function VerifyBanner({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const started = Date.now();
    let checking = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      try {
        if (await emailVerifiedYet()) await refreshVerification();
      } catch {
        /* offline or signed out of Firebase; the buttons still work */
      } finally {
        checking = false;
      }
    };
    const loop = () => {
      void check();
      timer = setTimeout(loop, Date.now() - started < VERIFY_FAST_FOR_MS ? VERIFY_POLL_MS : VERIFY_SLOW_POLL_MS);
    };
    const onFocus = () => void check();
    loop();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const resend = async () => {
    setBusy(true);
    setNote(null);
    try {
      await resendVerification();
      setNote("Sent. Check your inbox and spam folder.");
      setWait(RESEND_WAIT_S);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not send the email.");
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    setBusy(true);
    setNote(null);
    try {
      if (!(await refreshVerification())) setNote("Not verified yet. Open the link in the email we sent, then try again.");
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not check right now.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="acct-verify" role="status">
      <div>
        <strong>Verify your email</strong>
        <span>We sent a link to {email}. Open it and this page updates by itself.</span>
        <span className="acct-verify-wait"><i className="acct-verify-dot" aria-hidden="true" />Waiting for you to click the link</span>
        {note && <em>{note}</em>}
      </div>
      <div className="acct-verify-actions">
        <button type="button" className="btn outline sm" onClick={() => void resend()} disabled={busy || wait > 0}>{wait > 0 ? `Resend in ${wait}s` : "Resend email"}</button>
        <button type="button" className="btn solid sm" onClick={() => void recheck()} disabled={busy}>I have verified</button>
      </div>
    </div>
  );
}

function SecurityCard({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return setMsg({ ok: false, text: "Use a new password of at least 8 characters." });
    if (next !== again) return setMsg({ ok: false, text: "The new passwords do not match." });
    if (next === current) return setMsg({ ok: false, text: "Choose a password different from the current one." });
    setBusy(true);
    setMsg(null);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setAgain("");
      setMsg({ ok: true, text: "Password changed. Use the new one next time you sign in." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Could not change the password." });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await sendPasswordReset(email);
      setMsg({ ok: true, text: `Reset link sent to ${email}.` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Could not send the email." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="co-card">
      <header className="pane-head"><span>Security</span><span className="muted">Password</span></header>
      <form className="pane-body acct-security" onSubmit={save}>
        <label className="co-field">
          <span>Current password</span>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <div className="acct-security-row">
          <label className="co-field">
            <span>New password</span>
            <input type="password" autoComplete="new-password" placeholder="At least 8 characters" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label className="co-field">
            <span>Repeat new password</span>
            <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </label>
        </div>
        {msg && <span className={msg.ok ? "acct-ok" : "co-err"}>{msg.text}</span>}
        <div className="acct-security-actions">
          <button className="btn solid" disabled={busy || !current || !next || !again}>{busy ? "Saving…" : "Change password"}</button>
          <button type="button" className="btn ghost" onClick={() => void reset()} disabled={busy}>Forgot it? Email me a reset link</button>
        </div>
      </form>
    </div>
  );
}

function Dashboard({ onTest, onBuy }: AccountPageProps) {
  const account = useAccount()!;
  const licence = useLicence();
  const history = useHistory();
  const sync = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const [licences, setLicences] = useState<AccountLicence[]>([]);
  const [justVerified, setJustVerified] = useState(false);
  const wasVerified = useRef(account.emailVerified);

  useEffect(() => {
    if (account.emailVerified && !wasVerified.current) {
      wasVerified.current = true;
      setJustVerified(true);
      const id = setTimeout(() => setJustVerified(false), VERIFIED_NOTICE_MS);
      return () => clearTimeout(id);
    }
    wasVerified.current = account.emailVerified;
  }, [account.emailVerified]);

  useEffect(() => {
    void refreshAccount()
      .then((d) => d && setLicences(d.licences))
      .catch(() => {});
  }, [licence?.licence]);

  const trades = history.reduce((a, r) => a + r.trades, 0);
  const wins = history.reduce((a, r) => a + r.wins, 0);
  const best = history.reduce<number | null>((a, r) => (a === null || r.pnl > a ? r.pnl : a), null);
  const syncLabel =
    sync.status === "saving" ? "Saving…" : sync.status === "error" ? "Not saved, retrying" : "Saved to your account";

  const remove = async () => {
    if (!confirm("Delete your account and everything saved in it, including API keys and their sessions? Sessions on this device stay here. This cannot be undone.")) return;
    const password = prompt("Enter your password to confirm.");
    if (!password) return;
    setBusy(true);
    try {
      await deleteAccount(password);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not delete the account.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="acct-dash">
      <header className="acct-hello">
        <div className="acct-avatar" aria-hidden="true">{(account.name || account.email)[0].toUpperCase()}</div>
        <div>
          <h1>Hi{account.name ? `, ${account.name.split(" ")[0]}` : ""}</h1>
          <p>{account.email}</p>
        </div>
        <button type="button" className={`acct-sync ${sync.status}`} onClick={() => void syncNow()} title="Save now">
          <i />{syncLabel}
        </button>
      </header>

      {!account.emailVerified && <VerifyBanner email={account.email} />}
      {justVerified && (
        <div className="acct-verify done" role="status">
          <div>
            <strong>Email verified</strong>
            <span>Thanks, {account.email} is confirmed. Everything on your account is unlocked, including the cloud bot.</span>
          </div>
        </div>
      )}

      <div className="acct-stats">
        <div><small>Saved sessions</small><b>{history.length}</b></div>
        <div><small>Trades tested</small><b>{trades.toLocaleString()}</b></div>
        <div><small>Win rate</small><b>{trades ? `${((wins / trades) * 100).toFixed(1)}%` : "–"}</b></div>
        <div><small>Best session</small><b className={best !== null && best < 0 ? "neg" : "pos"}>{best === null ? "–" : usd(best)}</b></div>
      </div>

      <div className="acct-actions">
        <button className="btn solid lg" onClick={onTest}>Test the bot</button>
        {licence ? (
          <a className="btn outline lg" href="#/licence">My licence · {licence.plan}</a>
        ) : (
          <button className="btn outline lg" onClick={onBuy}>Buy the bot</button>
        )}
      </div>

      <div className="co-card">
        <header className="pane-head"><span>Recent sessions</span><span className="muted">Synced across your devices</span></header>
        <div className="pane-body">
          {history.length === 0 ? (
            <p className="muted">No sessions yet. Start a test drive and it saves here automatically.</p>
          ) : (
            <ul className="acct-sessions">
              {history.slice(0, 6).map((r) => (
                <li key={r.id}>
                  <span>{new Date(r.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
                  <span className="muted">{r.mode} · {r.trades} trades{r.running ? " · running" : ""}</span>
                  <b className={r.pnl < 0 ? "neg" : "pos"}>{usd(r.pnl)}</b>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <CloudBotCard onBuy={onBuy} />

      {(licences.length > 0 || licence) && (
        <div className="co-card">
          <header className="pane-head"><span>Your licences</span><span className="co-paid">Active</span></header>
          <div className="pane-body">
            {(licences.length ? licences : [{ ...licence!, addedAt: 0 }]).map((l) => (
              <div key={l.licence} className="acct-licence">
                <code>{l.licence}</code>
                <span className="muted">{l.plan} · v{l.version}{l.addedAt ? ` · ${new Date(l.addedAt).toLocaleDateString()}` : ""}</span>
                <span className="acct-licence-actions">
                  <ReceiptButton licence={l.licence} />
                  <a className="btn outline sm" href="#/licence">Download</a>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <ApiKeysCard />

      <SecurityCard email={account.email} />

      <footer className="acct-foot">
        <button className="btn ghost" onClick={() => void signOut()}>Sign out</button>
        <button className="btn ghost danger" onClick={remove} disabled={busy}>Delete account</button>
      </footer>
    </div>
  );
}

export default function AccountPage(props: AccountPageProps) {
  const account = useAccount();
  return (
    <div className="co acct">
      <div className="co-glow" />
      <nav className="co-nav">
        <a className="btn ghost" href="#/">‹ Back</a>
        <span className="wordmark">DOUBLE LLS<span>TRADING BOT</span></span>
        <span />
      </nav>
      <section className="acct-page">{account ? <Dashboard {...props} /> : <AuthForm forPurchase={props.forPurchase} />}</section>
    </div>
  );
}