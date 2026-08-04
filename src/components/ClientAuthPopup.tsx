import { useMemo, useState } from "react";
import { APP_NAME } from "../lib/brand";
import {
  clearOauthSession,
  derivOauthAuthorizeUrl,
  getSelectedOauthAccount,
  readOauthSession,
  selectOauthAccount,
  type OauthAccount,
} from "../lib/deriv/oauth";

interface ClientAuthPopupProps {
  open: boolean;
  /** After OAuth return — show account picker when multiple accounts. */
  pickAccounts?: OauthAccount[] | null;
  onPicked?: () => void;
  onSignedOut?: () => void;
}

export function ClientAuthPopup({
  open,
  pickAccounts,
  onPicked,
  onSignedOut,
}: ClientAuthPopupProps) {
  const session = readOauthSession();
  const selected = getSelectedOauthAccount();
  const [busy, setBusy] = useState(false);

  const accounts = useMemo(
    () => pickAccounts ?? session?.accounts ?? [],
    [pickAccounts, session?.accounts],
  );

  if (!open) return null;

  const goDeriv = () => {
    setBusy(true);
    window.location.href = derivOauthAuthorizeUrl();
  };

  const picking = accounts.length > 1 && !selected;

  return (
    <div className="client-auth" role="dialog" aria-modal="true" aria-labelledby="client-auth-title">
      <div className="client-auth__scrim" aria-hidden="true" />
      <div className="client-auth__card">
        <p className="client-auth__eyebrow">{APP_NAME}</p>
        <h2 id="client-auth-title">
          {picking ? "Choose your account" : "Connect with Deriv"}
        </h2>
        <p className="client-auth__lead">
          {picking
            ? "Pick demo or live balance for this session."
            : "Log in or create a Deriv account to trade Over / Under with your own balance."}
        </p>

        {picking ? (
          <ul className="client-auth__accounts">
            {accounts.map((account) => (
              <li key={account.loginid}>
                <button
                  type="button"
                  className="client-auth__account"
                  onClick={() => {
                    selectOauthAccount(account.loginid);
                    onPicked?.();
                  }}
                >
                  <strong>{account.kind === "demo" ? "Demo" : "Live"}</strong>
                  <span>{account.loginid}</span>
                  <em>{account.currency}</em>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="client-auth__actions">
            <button
              type="button"
              className="client-auth__primary"
              disabled={busy}
              onClick={goDeriv}
            >
              {busy ? "Redirecting…" : "Log in with Deriv"}
            </button>
            <button
              type="button"
              className="client-auth__secondary"
              disabled={busy}
              onClick={goDeriv}
            >
              Create Deriv account
            </button>
          </div>
        )}

        {selected ? (
          <button
            type="button"
            className="client-auth__link"
            onClick={() => {
              clearOauthSession();
              onSignedOut?.();
            }}
          >
            Use a different Deriv account
          </button>
        ) : (
          <p className="client-auth__note">
            You will leave briefly to Deriv, then return here with demo or live
            connected.
          </p>
        )}
      </div>
    </div>
  );
}
