import { useEffect, useState, type FormEvent } from "react";
import { CloudBotCard } from "./CloudBotCard";
import { deleteAccount, refreshAccount, signIn, signOut, signUp, syncNow, useAccount, useSyncStatus, type AccountLicence } from "./account";
import { ApiKeysCard } from "./ApiKeysCard";
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

function AuthForm({ forPurchase }: { forPurchase?: boolean }) {
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signup = mode === "signup";

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

function Dashboard({ onTest, onBuy }: AccountPageProps) {
  const account = useAccount()!;
  const licence = useLicence();
  const history = useHistory();
  const sync = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const [licences, setLicences] = useState<AccountLicence[]>([]);

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
    setBusy(true);
    try {
      await deleteAccount();
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
                <a className="btn outline sm" href="#/licence">Download</a>
              </div>
            ))}
          </div>
        </div>
      )}

      <ApiKeysCard />

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