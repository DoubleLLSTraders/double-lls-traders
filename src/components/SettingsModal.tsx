import { useEffect, useMemo, useState } from "react";
import { useAppAuth } from "../context/AuthContext";
import { accountCredentials, getAccountKind, setAccountKind } from "../lib/accountMode";
import {
  AUTH_LOCKOUT_MS,
  MAX_AUTH_FAILURES,
  SESSION_TTL_MS,
} from "../lib/auth/constants";
import { isAuthLocked } from "../lib/auth/security";
import {
  fetchTotpRecord,
  hasRecoveryCodes,
  hasTotpConfigured,
} from "../lib/auth/totpRemote";
import type { TotpRecord } from "../lib/auth/store";
import { config, type AccountKind } from "../lib/config";
import { listAccounts } from "../lib/deriv/rest";
import type { OptionsAccount } from "../lib/deriv/types";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** True while the bot holds a position, which must not be switched mid-trade. */
  botRunning: boolean;
}

type SettingsTab = "profile" | "security" | "trading";

function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(ms);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "expired";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function maskToken(token: string): string {
  if (token.length <= 8) return "••••••••";
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

export function SettingsModal({ open, onClose, botRunning }: SettingsModalProps) {
  const active = getAccountKind();
  const auth = useAppAuth();
  const [tab, setTab] = useState<SettingsTab>("profile");
  const [accounts, setAccounts] = useState<OptionsAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [totpRecord, setTotpRecord] = useState<TotpRecord | null>(null);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) {
      setAcknowledged(false);
      setTab("profile");
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoadError(null);

    void (async () => {
      try {
        const token = accountCredentials(active).token || config.token;
        const found = await listAccounts({
          appId: config.appId,
          restUrl: config.restUrl,
          token,
        });
        if (!cancelled) setAccounts(found);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, active]);

  useEffect(() => {
    if (!open || !auth.session?.email) {
      setTotpRecord(null);
      setSecurityError(null);
      return;
    }

    let cancelled = false;
    setSecurityError(null);

    void (async () => {
      try {
        const record = await fetchTotpRecord(auth.session!.email);
        if (!cancelled) setTotpRecord(record);
      } catch (error) {
        if (!cancelled) {
          setSecurityError(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, auth.session?.email]);

  const sessionRemaining = useMemo(() => {
    if (!auth.session) return null;
    return auth.session.expiresAt - now;
  }, [auth.session, now]);

  const lockout = useMemo(() => {
    if (!auth.session?.email) return null;
    return isAuthLocked(auth.session.email);
  }, [auth.session?.email, now]);

  if (!open) return null;

  const realAccount = accounts?.find((account) => !account.isVirtual) ?? null;
  const demoAccount = accounts?.find((account) => account.isVirtual) ?? null;
  const recoveryRemaining = totpRecord?.backupCodeHashes?.length ?? 0;
  const totpEnabled = hasTotpConfigured(totpRecord);
  const recoveryConfigured = hasRecoveryCodes(totpRecord);

  function choose(kind: AccountKind) {
    if (kind === active || botRunning) return;
    if (kind === "real" && !acknowledged) return;
    setAccountKind(kind);
    onClose();
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Settings">
      <button type="button" className="modal__scrim" aria-label="Close settings" onClick={onClose} />

      <div className="modal__card settings-modal">
        <header className="modal__head">
          <h2>Settings</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="settings-modal__layout">
          <nav className="settings-modal__nav" aria-label="Settings sections">
            <button
              type="button"
              className={`settings-modal__nav-btn ${tab === "profile" ? "is-active" : ""}`}
              onClick={() => setTab("profile")}
            >
              Profile
            </button>
            <button
              type="button"
              className={`settings-modal__nav-btn ${tab === "security" ? "is-active" : ""}`}
              onClick={() => setTab("security")}
            >
              Security
            </button>
            <button
              type="button"
              className={`settings-modal__nav-btn ${tab === "trading" ? "is-active" : ""}`}
              onClick={() => setTab("trading")}
            >
              Trading
            </button>
          </nav>

          <div className="settings-modal__panel">
            {tab === "profile" ? (
              <ProfilePanel session={auth.session} sessionRemaining={sessionRemaining} />
            ) : null}

            {tab === "security" ? (
              <SecurityPanel
                email={auth.session?.email ?? null}
                name={auth.session?.name ?? null}
                session={auth.session}
                sessionRemaining={sessionRemaining}
                totpEnabled={totpEnabled}
                recoveryConfigured={recoveryConfigured}
                recoveryRemaining={recoveryRemaining}
                totpSetupAt={totpRecord?.setupAt ?? null}
                securityError={securityError}
                lockout={lockout}
                onSignOut={() => {
                  auth.signOut();
                  onClose();
                }}
              />
            ) : null}

            {tab === "trading" ? (
              <TradingPanel
                active={active}
                botRunning={botRunning}
                acknowledged={acknowledged}
                setAcknowledged={setAcknowledged}
                demoAccount={demoAccount}
                realAccount={realAccount}
                accounts={accounts}
                loadError={loadError}
                onChoose={choose}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfilePanel({
  session,
  sessionRemaining,
}: {
  session: ReturnType<typeof useAppAuth>["session"];
  sessionRemaining: number | null;
}) {
  if (!session) {
    return <p className="modal__error">No active session. Sign in again.</p>;
  }

  return (
    <>
      <section className="settings-profile">
        <div className="settings-profile__hero">
          {session.picture ? (
            <img
              className="settings-profile__avatar"
              src={session.picture}
              alt=""
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="settings-profile__avatar settings-profile__avatar--fallback" aria-hidden>
              {session.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div>
            <h3 className="settings-profile__name">{session.name}</h3>
            <p className="settings-profile__email">{session.email}</p>
            <span className="settings-badge settings-badge--ok">Authorized operator</span>
          </div>
        </div>
      </section>

      <section className="modal__section settings-modal__section">
        <h3>Session</h3>
        <dl className="settings-kv">
          <div className="settings-kv__row">
            <dt>Signed in</dt>
            <dd>{formatDateTime(session.verifiedAt)}</dd>
          </div>
          <div className="settings-kv__row">
            <dt>Session expires</dt>
            <dd>
              {formatDateTime(session.expiresAt)}
              {sessionRemaining !== null ? (
                <small> · {formatDuration(sessionRemaining)} left</small>
              ) : null}
            </dd>
          </div>
          <div className="settings-kv__row">
            <dt>Session limit</dt>
            <dd>{Math.round(SESSION_TTL_MS / 3_600_000)} hours</dd>
          </div>
          <div className="settings-kv__row">
            <dt>Device binding</dt>
            <dd>
              <span className="settings-badge settings-badge--ok">Active</span>
              <small> Bound to this browser fingerprint</small>
            </dd>
          </div>
          <div className="settings-kv__row">
            <dt>Session token</dt>
            <dd>
              <code>{maskToken(session.token)}</code>
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}

function SecurityPanel({
  email,
  name,
  session,
  sessionRemaining,
  totpEnabled,
  recoveryConfigured,
  recoveryRemaining,
  totpSetupAt,
  securityError,
  lockout,
  onSignOut,
}: {
  email: string | null;
  name: string | null;
  session: ReturnType<typeof useAppAuth>["session"];
  sessionRemaining: number | null;
  totpEnabled: boolean;
  recoveryConfigured: boolean;
  recoveryRemaining: number;
  totpSetupAt: number | null;
  securityError: string | null;
  lockout: ReturnType<typeof isAuthLocked> | null;
  onSignOut: () => void;
}) {
  const recoveryLow = recoveryRemaining > 0 && recoveryRemaining <= 2;

  return (
    <>
      <section className="modal__section settings-modal__section">
        <h3>Identity</h3>
        <dl className="settings-kv">
          <div className="settings-kv__row">
            <dt>Google account</dt>
            <dd>{email ?? "—"}</dd>
          </div>
          <div className="settings-kv__row">
            <dt>Display name</dt>
            <dd>{name ?? "—"}</dd>
          </div>
          <div className="settings-kv__row">
            <dt>Access</dt>
            <dd>
              <span className="settings-badge settings-badge--ok">Allowlisted</span>
            </dd>
          </div>
        </dl>
      </section>

      <section className="modal__section settings-modal__section">
        <h3>Two-factor authentication</h3>
        <p className="modal__note">
          Google Authenticator (TOTP) is required on every sign-in. Recovery codes are stored as
          SHA-256 hashes in Firebase Firestore.
        </p>

        {securityError ? <p className="modal__error">Could not load 2FA status · {securityError}</p> : null}

        <dl className="settings-kv">
          <div className="settings-kv__row">
            <dt>Authenticator</dt>
            <dd>
              {totpEnabled ? (
                <span className="settings-badge settings-badge--ok">Enabled</span>
              ) : (
                <span className="settings-badge settings-badge--warn">Not configured</span>
              )}
              {totpSetupAt ? <small> · since {formatDateTime(totpSetupAt)}</small> : null}
            </dd>
          </div>
          <div className="settings-kv__row">
            <dt>TOTP window</dt>
            <dd>30 seconds · Google Authenticator</dd>
          </div>
          <div className="settings-kv__row">
            <dt>Recovery codes</dt>
            <dd>
              {recoveryConfigured ? (
                <>
                  <span
                    className={`settings-badge ${recoveryLow ? "settings-badge--warn" : "settings-badge--ok"}`}
                  >
                    {recoveryRemaining} remaining
                  </span>
                  <small> · one-time use · hashed in Firestore</small>
                </>
              ) : (
                <span className="settings-badge settings-badge--warn">Not saved</span>
              )}
            </dd>
          </div>
          <div className="settings-kv__row">
            <dt>Brute-force lockout</dt>
            <dd>
              {lockout?.locked && lockout.until ? (
                <>
                  <span className="settings-badge settings-badge--warn">Locked</span>
                  <small> until {formatDateTime(lockout.until)}</small>
                </>
              ) : (
                <>
                  {MAX_AUTH_FAILURES} failed attempts →{" "}
                  {Math.round(AUTH_LOCKOUT_MS / 60_000)} min lockout
                </>
              )}
            </dd>
          </div>
        </dl>

        {recoveryLow ? (
          <p className="modal__warn">
            Only {recoveryRemaining} recovery code(s) left. Sign out and complete setup to regenerate
            when codes run out.
          </p>
        ) : null}
      </section>

      <section className="modal__section settings-modal__section">
        <h3>Active session</h3>
        <dl className="settings-kv">
          <div className="settings-kv__row">
            <dt>2FA verified</dt>
            <dd>{session ? formatDateTime(session.verifiedAt) : "—"}</dd>
          </div>
          <div className="settings-kv__row">
            <dt>Expires in</dt>
            <dd>{sessionRemaining !== null ? formatDuration(sessionRemaining) : "—"}</dd>
          </div>
        </dl>
        <p className="modal__note">
          Sign out to require Google sign-in and a fresh Authenticator code on this device.
        </p>
        <button type="button" className="auth-screen__submit modal__signout" onClick={onSignOut}>
          Sign out
        </button>
      </section>
    </>
  );
}

function TradingPanel({
  active,
  botRunning,
  acknowledged,
  setAcknowledged,
  demoAccount,
  realAccount,
  accounts,
  loadError,
  onChoose,
}: {
  active: AccountKind;
  botRunning: boolean;
  acknowledged: boolean;
  setAcknowledged: (value: boolean) => void;
  demoAccount: OptionsAccount | null;
  realAccount: OptionsAccount | null;
  accounts: OptionsAccount[] | null;
  loadError: string | null;
  onChoose: (kind: AccountKind) => void;
}) {
  return (
    <section className="modal__section settings-modal__section">
      <h3>Deriv account</h3>
      <p className="modal__note">
        Switching reconnects the feed and reloads the balance. Trade history stays.
      </p>

      <div className="acctpick">
        <AccountOption
          kind="demo"
          label="Demo"
          detail="Practice money. Nothing at risk."
          account={demoAccount}
          active={active === "demo"}
          disabled={botRunning}
          onSelect={onChoose}
        />
        <AccountOption
          kind="real"
          label="Live"
          detail="Real money. Every loss is yours."
          account={realAccount}
          active={active === "real"}
          disabled={botRunning || !acknowledged}
          onSelect={onChoose}
        />
      </div>

      {loadError ? <p className="modal__error">Could not read accounts · {loadError}</p> : null}

      {accounts && !realAccount ? (
        <p className="modal__error">
          This token cannot see a real account. Add one on Deriv, or set VITE_DERIV_TOKEN_REAL in
          .env.
        </p>
      ) : null}

      {realAccount && realAccount.balance <= 0 && active !== "real" ? (
        <p className="modal__warn">
          The live account holds {realAccount.balance.toFixed(2)} {realAccount.currency}. Trades
          will be rejected until it is funded.
        </p>
      ) : null}

      {active !== "real" ? (
        <label className="modal__ack">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={botRunning}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>
            I understand live trading risks real money, and that this bot runs at a negative
            expected value of about −1.3% per trade.
          </span>
        </label>
      ) : null}

      {botRunning ? <p className="modal__warn">Stop the bot before switching accounts.</p> : null}
    </section>
  );
}

function AccountOption({
  kind,
  label,
  detail,
  account,
  active,
  disabled,
  onSelect,
}: {
  kind: AccountKind;
  label: string;
  detail: string;
  account: OptionsAccount | null;
  active: boolean;
  disabled: boolean;
  onSelect: (kind: AccountKind) => void;
}) {
  return (
    <button
      type="button"
      className={`acctpick__card ${active ? "is-active" : ""} ${kind === "real" ? "is-real" : ""}`}
      aria-pressed={active}
      disabled={disabled && !active}
      onClick={() => onSelect(kind)}
    >
      <span className="acctpick__label">
        {label}
        {active ? <em>Current</em> : null}
      </span>
      <strong className="acctpick__balance">
        {account ? `${account.balance.toFixed(2)} ${account.currency}` : "—"}
      </strong>
      <small className="acctpick__id">{account?.accountId ?? "not available"}</small>
      <small className="acctpick__detail">{detail}</small>
    </button>
  );
}
