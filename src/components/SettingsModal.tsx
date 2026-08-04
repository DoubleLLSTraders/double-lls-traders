import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useOptionalAppAuth } from "../context/AuthContext";
import { accountCredentials, getAccountKind, setAccountKind } from "../lib/accountMode";
import {
  AUTH_LOCKOUT_MS,
  MAX_AUTH_FAILURES,
  SESSION_TTL_MS,
} from "../lib/auth/constants";
import {
  clearAuthFailures,
  isAuthLocked,
  lockoutMessage,
  recordAuthFailure,
} from "../lib/auth/security";
import { verifyTotpCode } from "../lib/auth/totp";
import {
  fetchTotpRecord,
  hasRecoveryCodes,
  hasTotpConfigured,
} from "../lib/auth/totpRemote";
import { grantLiveAccess, LIVE_ACCESS_TTL_MS, type TotpRecord } from "../lib/auth/store";
import { config, type AccountKind } from "../lib/config";
import type { ConnectionState } from "../lib/deriv/types";
import { listAccounts } from "../lib/deriv/rest";
import type { OptionsAccount } from "../lib/deriv/types";
import {
  BOT_PROFILE_VERSION,
  BOT_SETTINGS_VERSION,
  MATCHES_PROFILE_VERSION,
  OVER_UNDER_VERSION,
  botVersionLabel,
} from "../lib/bot/version";
import type { TradeDesk } from "../lib/analysis/contractSide";
import {
  getActiveHub,
  getHubDisplayName,
  setActiveHub,
  setHubDisplayName,
  type HubId,
} from "../lib/hub";
import { DeskSwitch } from "./DeskSwitch";
import { SystemStatusPanel } from "./SystemStatusPanel";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** True while the bot holds a position, which must not be switched mid-trade. */
  botRunning: boolean;
  /** Which tab to show when the modal opens. */
  initialTab?: SettingsTab;
  feedState: ConnectionState;
  feedError: string | null;
  /** Active trade desk — Digits or Over/Under. */
  tradeDesk: TradeDesk;
  /** Switch Digits ↔ Over/Under (applies the matching bot profile). */
  onSelectDesk?: (desk: TradeDesk) => void;
  /** Fired after the active hub is persisted (digits desk vs Atlas). */
  onHubChange?: (hub: import("../lib/hub").HubId) => void;
  /** Hide Digits-only desk controls when Atlas settings are open. */
  hubMode?: "digits" | "atlas";
  /** Public client desk — hide admin hub / Google profile tabs. */
  clientMode?: boolean;
}

export type SettingsTab = "profile" | "security" | "trading" | "hub" | "status";

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

export function SettingsModal({
  open,
  onClose,
  botRunning,
  initialTab = "profile",
  feedState,
  feedError,
  tradeDesk,
  onSelectDesk,
  onHubChange,
  hubMode = "digits",
  clientMode = false,
}: SettingsModalProps) {
  const active = getAccountKind();
  const auth = useOptionalAppAuth();
  const [tab, setTab] = useState<SettingsTab>(clientMode ? "trading" : "profile");
  const [accounts, setAccounts] = useState<OptionsAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [totpRecord, setTotpRecord] = useState<TotpRecord | null>(null);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [liveVerifyOpen, setLiveVerifyOpen] = useState(false);
  const [hubNameDraft, setHubNameDraft] = useState(() => getHubDisplayName());
  const [activeHubDraft, setActiveHubDraft] = useState(() => getActiveHub());

  useEffect(() => {
    if (!open) {
      setAcknowledged(false);
      setLiveVerifyOpen(false);
      return;
    }

    setTab(clientMode ? "trading" : initialTab);
    setHubNameDraft(getHubDisplayName());
    setActiveHubDraft(getActiveHub());

    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open, initialTab, clientMode]);

  useEffect(() => {
    if (!open || clientMode) return;

    let cancelled = false;
    setLoadError(null);

    void (async () => {
      try {
        const token = accountCredentials(active).token || config.token;
        if (!token) return;
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
  }, [open, active, clientMode]);

  useEffect(() => {
    if (!open || !auth?.session?.email) {
      setTotpRecord(null);
      setSecurityError(null);
      return;
    }

    let cancelled = false;
    setSecurityError(null);
    const email = auth.session.email;

    void (async () => {
      try {
        const record = await fetchTotpRecord(email);
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
  }, [open, auth?.session?.email]);

  const sessionRemaining = useMemo(() => {
    if (!auth?.session) return null;
    return auth.session.expiresAt - now;
  }, [auth?.session, now]);

  const lockout = useMemo(() => {
    if (!auth?.session?.email) return null;
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

    if (kind === "demo") {
      setLiveVerifyOpen(false);
      setAccountKind("demo");
      onClose();
      return;
    }

    if (kind === "real") {
      if (!acknowledged) return;
      setLiveVerifyOpen(true);
    }
  }

  function confirmLiveSwitch() {
    grantLiveAccess();
    if (!setAccountKind("real")) {
      return;
    }
    setLiveVerifyOpen(false);
    onClose();
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Settings">
      <button type="button" className="modal__scrim" aria-label="Close settings" onClick={onClose} />

      <div className={`modal__card settings-modal ${tab === "status" ? "settings-modal--wide" : ""}`}>
        <header className="modal__head">
          <div className="settings-modal__head-title">
            <h2>Settings</h2>
            <span className="settings-modal__version" title={botVersionLabel()}>
              Bot v{BOT_SETTINGS_VERSION}
            </span>
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="settings-modal__layout">
          <nav className="settings-modal__nav" aria-label="Settings sections">
            {!clientMode ? (
              <button
                type="button"
                className={`settings-modal__nav-btn ${tab === "profile" ? "is-active" : ""}`}
                onClick={() => setTab("profile")}
              >
                Profile
              </button>
            ) : null}
            {!clientMode ? (
              <button
                type="button"
                className={`settings-modal__nav-btn ${tab === "security" ? "is-active" : ""}`}
                onClick={() => setTab("security")}
              >
                Security
              </button>
            ) : null}
            <button
              type="button"
              className={`settings-modal__nav-btn ${tab === "trading" ? "is-active" : ""}`}
              onClick={() => setTab("trading")}
            >
              Trading
            </button>
            {!clientMode ? (
              <button
                type="button"
                className={`settings-modal__nav-btn ${tab === "hub" ? "is-active" : ""}`}
                onClick={() => setTab("hub")}
              >
                Hub
              </button>
            ) : null}
            <button
              type="button"
              className={`settings-modal__nav-btn ${tab === "status" ? "is-active" : ""}`}
              onClick={() => setTab("status")}
            >
              Status
            </button>
          </nav>

          <div className="settings-modal__panel">
            {!clientMode && tab === "profile" && auth ? (
              <ProfilePanel session={auth.session} sessionRemaining={sessionRemaining} />
            ) : null}

            {!clientMode && tab === "security" && auth ? (
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
                liveVerifyOpen={liveVerifyOpen}
                onCancelLiveVerify={() => setLiveVerifyOpen(false)}
                onChoose={choose}
                onConfirmLiveSwitch={confirmLiveSwitch}
                email={auth?.session?.email ?? null}
                totpRecord={totpRecord}
                tradeDesk={tradeDesk}
                onSelectDesk={onSelectDesk ?? (() => {})}
                showDeskSwitch={!clientMode && hubMode === "digits" && !!onSelectDesk}
                clientMode={clientMode}
              />
            ) : null}

            {!clientMode && tab === "hub" ? (
              <HubPanel
                botRunning={botRunning}
                activeHub={activeHubDraft}
                hubName={hubNameDraft}
                onHubNameChange={setHubNameDraft}
                onSelectHub={(hub) => {
                  if (botRunning && hub !== activeHubDraft) {
                    const ok = window.confirm(
                      "A bot or open trade is active. Stop it and switch hubs anyway?",
                    );
                    if (!ok) return;
                  }
                  setActiveHub(hub);
                  setHubDisplayName(hubNameDraft);
                  setActiveHubDraft(hub);
                  onHubChange?.(hub);
                  if (hub !== hubMode) onClose();
                }}
                onSaveName={() => {
                  setHubDisplayName(hubNameDraft);
                }}
              />
            ) : null}

            {tab === "status" ? (
              <SystemStatusPanel
                feedState={feedState}
                feedError={feedError}
                email={auth?.session?.email ?? null}
                active={open && tab === "status"}
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
            <dt>Live account switch</dt>
            <dd>
              <span className="settings-badge settings-badge--ok">Authenticator required</span>
              <small>
                {" "}
                · re-verify every {Math.round(LIVE_ACCESS_TTL_MS / 60_000)} min
              </small>
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
  liveVerifyOpen,
  onCancelLiveVerify,
  onChoose,
  onConfirmLiveSwitch,
  email,
  totpRecord,
  tradeDesk,
  onSelectDesk,
  showDeskSwitch = true,
  clientMode = false,
}: {
  active: AccountKind;
  botRunning: boolean;
  acknowledged: boolean;
  setAcknowledged: (value: boolean) => void;
  demoAccount: OptionsAccount | null;
  realAccount: OptionsAccount | null;
  accounts: OptionsAccount[] | null;
  loadError: string | null;
  liveVerifyOpen: boolean;
  onCancelLiveVerify: () => void;
  onChoose: (kind: AccountKind) => void;
  onConfirmLiveSwitch: () => void;
  email: string | null;
  totpRecord: TotpRecord | null;
  tradeDesk: TradeDesk;
  onSelectDesk: (desk: TradeDesk) => void;
  showDeskSwitch?: boolean;
  clientMode?: boolean;
}) {
  return (
    <section className="modal__section settings-modal__section">
      {clientMode ? (
        <p className="modal__note">
          Over / Under desk · connect Demo or Live from the header after Deriv login.
        </p>
      ) : null}
      {showDeskSwitch ? (
      <div className="settings-desk-switch">
        <DeskSwitch
          value={tradeDesk}
          disabled={botRunning}
          onChange={onSelectDesk}
        />
        {botRunning ? (
          <p className="modal__note">
            Desk locked while a trade is open or settling — stop the bot to switch.
          </p>
        ) : (
          <p className="modal__note">
            Tap a desk → confirm → we sync live ticks and verify the contract on Deriv
            (Over + Under proposals) before it goes live.
          </p>
        )}
      </div>
      ) : (
        <p className="modal__note">
          Atlas hub is active — Digits / Over-Under desk switch is hidden. Open the Hub
          tab to return to the digits desk. Demo vs Live below still controls the Atlas
          wallet (paper ledger vs real MULTUP/MULTDOWN).
        </p>
      )}

      <div className="settings-bot-version" aria-label={botVersionLabel()}>
        <strong>Bot version</strong>
        <span>v{BOT_SETTINGS_VERSION}</span>
        <em>
          Differs v{BOT_PROFILE_VERSION} · Matches firm v{MATCHES_PROFILE_VERSION} · O/U v
          {OVER_UNDER_VERSION}
        </em>
        <p>
          {tradeDesk === "overunder"
            ? "BLITZ · Over/Under high-hit barriers · prove ~2s · same-tick buy"
            : "HIGH · Differs Steady/Safer+fast or Matches firm (hunt best hot) · same-tick buy"}
        </p>
      </div>

      {!clientMode ? <h3>Deriv account</h3> : null}
      {!clientMode ? (
      <p className="modal__note">
        Switching reconnects Digits and Atlas feeds and reloads the balance. Atlas Demo uses a
        practice ledger; Atlas Live places real MULTUP/MULTDOWN on your wallet. Trade history
        stays. Moving to <strong>Live</strong> requires Google Authenticator verification.
      </p>
      ) : null}

      {!clientMode ? (
        liveVerifyOpen ? (
          <LiveSwitchVerify
            email={email}
            totpRecord={totpRecord}
            onCancel={onCancelLiveVerify}
            onVerified={onConfirmLiveSwitch}
          />
        ) : (
          <>
            <div className="acctpick">
              <AccountOption
                kind="demo"
                label="Demo"
                detail="Practice money. Atlas papers; Digits use demo wallet."
                account={demoAccount}
                active={active === "demo"}
                disabled={botRunning}
                onSelect={onChoose}
              />
              <AccountOption
                kind="real"
                label="Live"
                detail="Real money. Atlas multipliers + Digits contracts on your wallet."
                account={realAccount}
                active={active === "real"}
                disabled={botRunning || !acknowledged}
                onSelect={onChoose}
              />
            </div>

            {loadError ? (
              <p className="modal__error">Could not read accounts · {loadError}</p>
            ) : null}

            {accounts && !realAccount ? (
              <p className="modal__error">
                This token cannot see a real account. Add one on Deriv, or set
                VITE_DERIV_TOKEN_REAL in .env.
              </p>
            ) : null}

            {realAccount && realAccount.balance <= 0 && active !== "real" ? (
              <p className="modal__warn">
                The live account holds {realAccount.balance.toFixed(2)}{" "}
                {realAccount.currency}. Trades will be rejected until it is funded.
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
                  I understand live trading risks real money, and that this bot runs
                  at a negative expected value of about −1.3% per trade.
                </span>
              </label>
            ) : null}

            {botRunning ? (
              <p className="modal__warn">Stop the bot before switching accounts.</p>
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}

function LiveSwitchVerify({
  email,
  totpRecord,
  onCancel,
  onVerified,
}: {
  email: string | null;
  totpRecord: TotpRecord | null;
  onCancel: () => void;
  onVerified: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!email) {
      setError("Session expired. Sign in again.");
      return;
    }

    const lock = isAuthLocked(email);
    if (lock.locked && lock.until) {
      setError(lockoutMessage(lock.until));
      return;
    }

    const secret = totpRecord?.secret;
    if (!secret) {
      setError("2FA is not configured for this account. Sign in again to set up Authenticator.");
      return;
    }

    setBusy(true);
    try {
      let activeSecret = secret;
      if (email) {
        const fresh = await fetchTotpRecord(email);
        if (fresh?.secret) activeSecret = fresh.secret;
      }

      if (!verifyTotpCode(activeSecret, code)) {
        const failed = recordAuthFailure(email);
        if (failed.locked && failed.until) {
          setError(lockoutMessage(failed.until));
        } else {
          setError("Invalid Authenticator code. Try again.");
        }
        return;
      }

      clearAuthFailures(email);
      onVerified();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-live-verify">
      <div className="settings-live-verify__head">
        <span className="settings-badge settings-badge--warn">Live switch</span>
        <h4>Confirm with Google Authenticator</h4>
        <p>
          Enter your 6-digit code to switch from Demo to Live
          {email ? ` as ${email}` : ""}.
        </p>
      </div>

      <form className="auth-screen__form settings-live-verify__form" onSubmit={submit}>
        <label className="auth-screen__field">
          <span>6-digit Authenticator code</span>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="000000"
            autoFocus
            disabled={busy}
          />
        </label>
        <div className="settings-live-verify__actions">
          <button
            type="button"
            className="settings-live-verify__cancel"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="auth-screen__submit"
            disabled={busy || code.length !== 6}
          >
            {busy ? "Verifying…" : "Switch to Live"}
          </button>
        </div>
      </form>

      {error ? <p className="modal__error">{error}</p> : null}
    </div>
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

function HubPanel({
  botRunning,
  activeHub,
  hubName,
  onHubNameChange,
  onSelectHub,
  onSaveName,
}: {
  botRunning: boolean;
  activeHub: HubId;
  hubName: string;
  onHubNameChange: (name: string) => void;
  onSelectHub: (hub: HubId) => void;
  onSaveName: () => void;
}) {
  return (
    <section className="modal__section settings-modal__section">
      <h3>Workspace hub</h3>
      <p className="modal__note">
        Switch between the Digits desk and the Atlas real-markets hub (Gold, Forex,
        Crypto). Atlas is isolated — it never shares bot state with Matches / Over-Under.
      </p>

      <div className="acctpick" role="group" aria-label="Active hub">
        <button
          type="button"
          className={`acctpick__card ${activeHub === "digits" ? "is-active" : ""}`}
          aria-pressed={activeHub === "digits"}
          onClick={() => onSelectHub("digits")}
        >
          <span className="acctpick__label">
            Digits desk
            {activeHub === "digits" ? <em>Current</em> : null}
          </span>
          <strong className="acctpick__balance">Matches · Differs · O/U</strong>
          <small className="acctpick__detail">
            Synthetic last-digit contracts on Volatility indices.
          </small>
        </button>
        <button
          type="button"
          className={`acctpick__card ${activeHub === "atlas" ? "is-active" : ""}`}
          aria-pressed={activeHub === "atlas"}
          onClick={() => onSelectHub("atlas")}
        >
          <span className="acctpick__label">
            {hubName.trim() || "Atlas"}
            {activeHub === "atlas" ? <em>Current</em> : null}
          </span>
          <strong className="acctpick__balance">Gold · FX · Crypto</strong>
          <small className="acctpick__detail">
            Real-market charts, signals, risk gates, and paper execution via Deriv.
          </small>
        </button>
      </div>

      {botRunning ? (
        <p className="modal__note">
          Tip: if a trade is open, confirm the switch — Atlas will stop the bot
          when you leave.
        </p>
      ) : null}

      <label className="bot-field" style={{ marginTop: "1rem", display: "block" }}>
        <span>Atlas display name</span>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.35rem" }}>
          <input
            type="text"
            value={hubName}
            maxLength={40}
            onChange={(event) => onHubNameChange(event.target.value)}
            placeholder="Atlas"
            aria-label="Atlas display name"
          />
          <button type="button" className="btn btn--ghost" onClick={onSaveName}>
            Save name
          </button>
        </div>
      </label>

      <p className="modal__note" style={{ marginTop: "1rem" }}>
        No guaranteed profits. Every Atlas recommendation includes confidence, risk, and
        an explanation. Auto-trade stays blocked until risk rules pass.
      </p>
    </section>
  );
}
