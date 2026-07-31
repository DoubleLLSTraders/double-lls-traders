import { GoogleLogin, type CredentialResponse } from "@react-oauth/google";
import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { useTheme } from "../hooks/useTheme";
import logoDark from "../assets/logo.png";
import logoLight from "../assets/logo-light.png";
import { isAccessControlConfigured } from "../hooks/useAppAuth";
import { AuthProvider, useAppAuth } from "../context/AuthContext";
import { downloadBackupCodesFile } from "../lib/auth/backupCodes";
import { APP_NAME } from "../lib/brand";

interface AuthGateProps {
  children: React.ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  if (!isAccessControlConfigured()) {
    return <AuthConfigNotice />;
  }

  return (
    <AuthProvider>
      <AuthGateInner>{children}</AuthGateInner>
    </AuthProvider>
  );
}

function AuthGateInner({ children }: AuthGateProps) {
  const auth = useAppAuth();

  if (auth.phase === "loading") {
    return (
      <div className="auth-screen">
        <AuthShell
          title={auth.busy ? "Checking access…" : "Loading…"}
          subtitle="Google sign-in + Google Authenticator. No email/password."
        />
      </div>
    );
  }

  if (auth.phase === "authenticated") {
    return children;
  }

  return (
    <div className="auth-screen">
      {auth.phase === "sign-in" ? <SignInPanel /> : null}
      {auth.phase === "totp-setup" ? <TotpSetupPanel /> : null}
      {auth.phase === "totp-verify" ? <TotpVerifyPanel /> : null}
    </div>
  );
}

function AuthConfigNotice() {
  return (
    <div className="auth-screen">
      <AuthShell
        title="Access control not configured"
        subtitle="Google sign-in + Google Authenticator (QR). TOTP secrets saved in Firebase."
      >
        <p className="auth-screen__note">
          Add these to <code>.env</code>, then restart the dev server:
        </p>
        <ul className="auth-screen__list">
          <li>
            <code>VITE_GOOGLE_CLIENT_ID</code> — OAuth Web client from the{" "}
            <strong>same Firebase / Google Cloud project</strong> (Authentication → Google → Web client
            ID). Must match <code>VITE_FIREBASE_PROJECT_ID</code>.
          </li>
          <li>
            Firebase Console → Authentication → Sign-in method → <strong>enable Google</strong>.
          </li>
          <li>
            <code>VITE_FIREBASE_API_KEY</code>, <code>VITE_FIREBASE_PROJECT_ID</code>,{" "}
            <code>VITE_FIREBASE_APP_ID</code>, and related Firebase web config.
          </li>
          <li>
            Enable Firestore in Firebase, deploy <code>firestore.rules</code>, and create the{" "}
            <code>totp_secrets</code> collection (auto-created on first setup).
          </li>
        </ul>
      </AuthShell>
    </div>
  );
}

function RecoveryCodesBlock({
  email,
  codes,
  onDownloaded,
  downloaded,
}: {
  email: string;
  codes: string[];
  onDownloaded: () => void;
  downloaded: boolean;
}) {
  return (
    <section className="auth-screen__recovery">
      <div className="auth-screen__recovery-head">
        <strong>Recovery codes</strong>
        <span>8 one-time codes · saved to Firebase · each works once</span>
      </div>
      <ul className="auth-screen__recovery-list">
        {codes.map((recoveryCode) => (
          <li key={recoveryCode}>
            <code>{recoveryCode}</code>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="auth-screen__download"
        onClick={() => {
          downloadBackupCodesFile(email, codes);
          onDownloaded();
        }}
      >
        {downloaded ? "Download again" : "Download recovery codes"}
      </button>
      {!downloaded ? (
        <p className="auth-screen__warn">Download and store these before continuing.</p>
      ) : null}
    </section>
  );
}

function SignInPanel() {
  const auth = useAppAuth();

  return (
    <AuthShell
      title="Sign in required"
      subtitle="Sign in with Google, then enter your Google Authenticator code. No password."
    >
      <div className="auth-screen__google">
        <GoogleLogin
          onSuccess={(response: CredentialResponse) => {
            if (response.credential) void auth.signInWithGoogle(response.credential);
          }}
          onError={() => auth.reportError("Google sign-in was cancelled or failed.")}
          useOneTap={false}
          theme="filled_black"
          size="large"
          text="continue_with"
          shape="pill"
        />
      </div>

      <div className="auth-screen__divider" aria-hidden="true">
        <span>or</span>
      </div>

      <div className="auth-screen__alt">
        <button
          type="button"
          className="auth-screen__recovery-btn"
          onClick={() => auth.requestRecoverySignIn()}
        >
          Lost phone? Use recovery code
        </button>
        <p className="auth-screen__hint">Select recovery, then continue with Google.</p>
      </div>

      {auth.error ? <p className="auth-screen__error">{auth.error}</p> : null}
    </AuthShell>
  );
}

function TotpSetupPanel() {
  const auth = useAppAuth();
  const [code, setCode] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const recoveryOnly = auth.setupMode === "recovery-only";
  const email = auth.pendingProfile?.email ?? "";

  useEffect(() => {
    if (!auth.setupUri) return;
    let cancelled = false;
    void QRCode.toDataURL(auth.setupUri, { margin: 1, width: 220 }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [auth.setupUri]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!downloaded) {
      auth.reportError("Download recovery codes before finishing setup.");
      return;
    }
    auth.clearError();
    void auth.confirmTotpSetup(code);
  }

  if (recoveryOnly) {
    return (
      <AuthShell
        title="Save recovery codes"
        subtitle={`New recovery codes for ${email}. Already saved to Firebase.`}
      >
        {auth.setupBackupCodes.length > 0 ? (
          <RecoveryCodesBlock
            email={email}
            codes={auth.setupBackupCodes}
            downloaded={downloaded}
            onDownloaded={() => setDownloaded(true)}
          />
        ) : null}
        <button
          type="button"
          className="auth-screen__submit"
          disabled={!downloaded || auth.busy}
          onClick={auth.continueAfterRecoverySave}
        >
          Continue to sign in
        </button>
        {auth.error ? <p className="auth-screen__error">{auth.error}</p> : null}
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Set up Google Authenticator"
      subtitle={`One-time QR setup for ${email}. Saved to Firebase.`}
    >
      <ol className="auth-screen__steps">
        <li>Install Google Authenticator on your phone.</li>
        <li>Scan this QR code or enter the manual key.</li>
        <li>Download recovery codes and store them safely.</li>
        <li>Enter the 6-digit code to finish setup.</li>
      </ol>

      <div className="auth-screen__qr">
        {qrDataUrl ? (
          <img src={qrDataUrl} alt="Scan in Google Authenticator" width={220} height={220} />
        ) : (
          <div className="auth-screen__qr-placeholder">Generating QR…</div>
        )}
      </div>

      {auth.setupSecret ? (
        <p className="auth-screen__secret">
          Manual key: <code>{auth.setupSecret}</code>
        </p>
      ) : null}

      {auth.setupBackupCodes.length > 0 ? (
        <RecoveryCodesBlock
          email={email}
          codes={auth.setupBackupCodes}
          downloaded={downloaded}
          onDownloaded={() => setDownloaded(true)}
        />
      ) : null}

      <form className="auth-screen__form" onSubmit={submit}>
        <label className="auth-screen__field">
          <span>6-digit code</span>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="000000"
            autoFocus
            disabled={auth.busy}
          />
        </label>
        <button
          type="submit"
          className="auth-screen__submit"
          disabled={auth.busy || code.length !== 6 || !downloaded}
        >
          {auth.busy ? "Saving to Firebase…" : "Finish setup"}
        </button>
      </form>

      {auth.error ? <p className="auth-screen__error">{auth.error}</p> : null}
    </AuthShell>
  );
}

function TotpVerifyPanel() {
  const auth = useAppAuth();
  const [code, setCode] = useState("");
  const recovery = auth.verifyMode === "recovery";

  function submit(event: FormEvent) {
    event.preventDefault();
    auth.clearError();
    void auth.verifyTotp(code);
  }

  return (
    <AuthShell
      title={recovery ? "Recovery code" : "Two-factor code"}
      subtitle={
        recovery
          ? `Signed in as ${auth.pendingProfile?.email ?? "your account"}. Enter one saved recovery code.`
          : `Signed in as ${auth.pendingProfile?.email ?? "your account"}. Enter Google Authenticator.`
      }
    >
      <form className="auth-screen__form" onSubmit={submit}>
        <label className="auth-screen__field">
          <span>{recovery ? "Recovery code" : "6-digit Authenticator code"}</span>
          <input
            inputMode={recovery ? "text" : "numeric"}
            autoComplete="one-time-code"
            maxLength={recovery ? 16 : 6}
            value={code}
            onChange={(event) =>
              setCode(
                recovery
                  ? event.target.value.toUpperCase()
                  : event.target.value.replace(/\D/g, "").slice(0, 6),
              )
            }
            placeholder={recovery ? "XXXX-XXXX" : "000000"}
            autoFocus
            disabled={auth.busy}
          />
        </label>
        <button
          type="submit"
          className="auth-screen__submit"
          disabled={auth.busy || code.trim().length < (recovery ? 8 : 6)}
        >
          {auth.busy ? "Verifying…" : "Unlock trading"}
        </button>
      </form>

      <div className="auth-screen__alt auth-screen__alt--compact">
        <button
          type="button"
          className="auth-screen__recovery-btn"
          onClick={() => {
            auth.clearError();
            setCode("");
            auth.setVerifyMode(recovery ? "authenticator" : "recovery");
          }}
        >
          {recovery ? "Use Authenticator instead" : "Use recovery code"}
        </button>
      </div>

      <button type="button" className="auth-screen__link" onClick={() => auth.signOut()}>
        Sign out · use a different Google account
      </button>

      {auth.error ? <p className="auth-screen__error">{auth.error}</p> : null}
    </AuthShell>
  );
}

function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  const { theme } = useTheme();
  return (
    <div className="auth-screen__card">
      <img
        src={theme === "light" ? logoLight : logoDark}
        alt={APP_NAME}
        className="auth-screen__logo"
      />
      <h1>{title}</h1>
      <p className="auth-screen__lead">{subtitle}</p>
      {children}
    </div>
  );
}

export function AuthSignOutButton() {
  const auth = useAppAuth();
  if (auth.phase !== "authenticated" || !auth.session) return null;
  return (
    <button
      type="button"
      className="topbar__signout"
      onClick={auth.signOut}
      title={`Sign out ${auth.session.email}`}
    >
      Sign out
    </button>
  );
}
