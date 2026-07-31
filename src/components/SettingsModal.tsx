import { useEffect, useState } from "react";
import { useAppAuth } from "../context/AuthContext";
import { accountCredentials, getAccountKind, setAccountKind } from "../lib/accountMode";
import { config, type AccountKind } from "../lib/config";
import { listAccounts } from "../lib/deriv/rest";
import type { OptionsAccount } from "../lib/deriv/types";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** True while the bot holds a position, which must not be switched mid-trade. */
  botRunning: boolean;
}

export function SettingsModal({ open, onClose, botRunning }: SettingsModalProps) {
  const active = getAccountKind();
  const auth = useAppAuth();
  const [accounts, setAccounts] = useState<OptionsAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!open) {
      setAcknowledged(false);
      return;
    }

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

  if (!open) return null;

  const realAccount = accounts?.find((account) => !account.isVirtual) ?? null;
  const demoAccount = accounts?.find((account) => account.isVirtual) ?? null;

  function choose(kind: AccountKind) {
    if (kind === active || botRunning) return;
    if (kind === "real" && !acknowledged) return;
    setAccountKind(kind);
    onClose();
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Settings">
      <button type="button" className="modal__scrim" aria-label="Close settings" onClick={onClose} />

      <div className="modal__card">
        <header className="modal__head">
          <h2>Settings</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <section className="modal__section">
          <h3>Account</h3>
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
              onSelect={choose}
            />
            <AccountOption
              kind="real"
              label="Live"
              detail="Real money. Every loss is yours."
              account={realAccount}
              active={active === "real"}
              disabled={botRunning || !acknowledged}
              onSelect={choose}
            />
          </div>

          {loadError ? <p className="modal__error">Could not read accounts · {loadError}</p> : null}

          {accounts && !realAccount ? (
            <p className="modal__error">
              This token cannot see a real account. Add one on Deriv, or set
              VITE_DERIV_TOKEN_REAL in .env.
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

          {botRunning ? (
            <p className="modal__warn">Stop the bot before switching accounts.</p>
          ) : null}
        </section>

        <section className="modal__section">
          <h3>Session</h3>
          <p className="modal__note">
            Signed in as {auth.session?.email ?? "unknown"}. Sign out to require Google and 2FA
            again.
          </p>
          <button
            type="button"
            className="auth-screen__submit modal__signout"
            onClick={() => {
              auth.signOut();
              onClose();
            }}
          >
            Sign out
          </button>
        </section>
      </div>
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
