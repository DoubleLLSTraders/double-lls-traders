import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { enforceLiveAccessPolicy, setAccountKind } from "../lib/accountMode";
import { generateBackupCodes, isBackupCodeInput } from "../lib/auth/backupCodes";
import {
  clearLiveAccess,
  clearSession,
  readSession,
  writeSession,
  type AuthSession,
} from "../lib/auth/store";
import {
  isAllowedEmail,
  profileFromFirebaseUser,
  type GoogleProfile,
} from "../lib/auth/google";
import { createTotpSecret, verifyTotpCode } from "../lib/auth/totp";
import {
  consumeBackupCode,
  fetchTotpRecord,
  hasRecoveryCodes,
  saveTotpRecordRemote,
} from "../lib/auth/totpRemote";
import { isFirebaseConfigured } from "../lib/firebase/config";
import {
  explainFirebaseAuthError,
  firebaseMatchesEmail,
  signInWithGooglePopup,
  signOutFirebase,
  waitForFirebaseAuth,
} from "../lib/firebase/auth";
import {
  clearAuthFailures,
  isAuthLocked,
  lockoutMessage,
  recordAuthFailure,
} from "../lib/auth/security";
import { APP_NAME } from "../lib/auth/constants";

export type AuthPhase =
  | "loading"
  | "sign-in"
  | "totp-setup"
  | "totp-verify"
  | "authenticated";

export type VerifyMode = "authenticator" | "recovery";
export type SetupMode = "full" | "recovery-only";

export interface AppAuth {
  phase: AuthPhase;
  session: AuthSession | null;
  pendingProfile: GoogleProfile | null;
  error: string | null;
  busy: boolean;
  verifyMode: VerifyMode;
  setupMode: SetupMode;
  setupSecret: string | null;
  setupUri: string | null;
  setupBackupCodes: string[];
  signInWithGoogle: () => Promise<void>;
  confirmTotpSetup: (code: string) => Promise<boolean>;
  verifyTotp: (code: string) => Promise<boolean>;
  setVerifyMode: (mode: VerifyMode) => void;
  requestRecoverySignIn: () => void;
  continueAfterRecoverySave: () => void;
  signOut: () => void;
  clearError: () => void;
  reportError: (message: string) => void;
}

export function isAccessControlConfigured(): boolean {
  return isFirebaseConfigured();
}

export function useAppAuthState(): AppAuth {
  const [phase, setPhase] = useState<AuthPhase>("loading");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [pendingProfile, setPendingProfile] = useState<GoogleProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifyMode, setVerifyMode] = useState<VerifyMode>("authenticator");
  const [setupMode, setSetupMode] = useState<SetupMode>("full");
  const preferRecoveryRef = useRef(false);
  const [setupSecret, setSetupSecret] = useState<string | null>(null);
  const [setupUri, setSetupUri] = useState<string | null>(null);
  const [setupBackupCodes, setSetupBackupCodes] = useState<string[]>([]);
  const [storedTotpSecret, setStoredTotpSecret] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const firebaseUser = await waitForFirebaseAuth();
      if (cancelled) return;

      const existing = readSession();
      if (
        existing &&
        firebaseUser?.email &&
        firebaseMatchesEmail(existing.email)
      ) {
        setSession(existing);
        setPhase("authenticated");
        return;
      }

      if (existing) {
        clearSession();
        clearLiveAccess();
      }
      if (firebaseUser) {
        try {
          await signOutFirebase();
        } catch {
          // ignore
        }
      }
      setPhase("sign-in");
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(() => {
    void signOutFirebase();
    clearSession();
    clearLiveAccess();
    setAccountKind("demo");
    setSession(null);
    setPendingProfile(null);
    setSetupSecret(null);
    setSetupUri(null);
    setSetupBackupCodes([]);
    setStoredTotpSecret(null);
    setVerifyMode("authenticator");
    setSetupMode("full");
    preferRecoveryRef.current = false;
    setError(null);
    setBusy(false);
    setPhase("sign-in");
  }, []);

  useEffect(() => {
    if (phase !== "authenticated" || !session) return;

    const interval = window.setInterval(() => {
      enforceLiveAccessPolicy();
      if (!firebaseMatchesEmail(session.email)) {
        signOut();
      }
    }, 60_000);

    return () => window.clearInterval(interval);
  }, [phase, session, signOut]);

  const finishAuth = useCallback((profile: GoogleProfile) => {
    const next = writeSession(profile);
    setSession(next);
    setPendingProfile(null);
    setSetupSecret(null);
    setSetupUri(null);
    setSetupBackupCodes([]);
    setStoredTotpSecret(null);
    setVerifyMode("authenticator");
    setSetupMode("full");
    preferRecoveryRef.current = false;
    setError(null);
    setBusy(false);
    setPhase("authenticated");
  }, []);

  const beginTotpSetup = useCallback((email: string) => {
    const setup = createTotpSecret(email);
    setStoredTotpSecret(null);
    setSetupSecret(setup.secret);
    setSetupUri(setup.uri);
    setSetupBackupCodes(generateBackupCodes());
    setSetupMode("full");
    setVerifyMode("authenticator");
    setPhase("totp-setup");
  }, []);

  const signInWithGoogle = useCallback(async () => {
      setError(null);
      setBusy(true);
      setPhase("loading");

      try {
        const firebaseUser = await signInWithGooglePopup();
        const profile = profileFromFirebaseUser(firebaseUser);
        if (!isAllowedEmail(profile.email)) {
          await signOutFirebase();
          setError(`This Google account is not authorized for ${APP_NAME}.`);
          setPhase("sign-in");
          return;
        }

        setPendingProfile(profile);
        let remote = await fetchTotpRecord(profile.email);

        if (remote) {
          const lock = isAuthLocked(profile.email);
          if (lock.locked && lock.until) {
            setError(lockoutMessage(lock.until));
            setPhase("sign-in");
            return;
          }

          if (!hasRecoveryCodes(remote)) {
            const codes = generateBackupCodes();
            remote = await saveTotpRecordRemote(profile.email, remote.secret, codes);
            setSetupBackupCodes(codes);
            setSetupSecret(null);
            setSetupUri(null);
            setStoredTotpSecret(remote.secret);
            setSetupMode("recovery-only");
            setPhase("totp-setup");
            return;
          }

          setStoredTotpSecret(remote.secret);
          setSetupSecret(null);
          setSetupUri(null);
          setSetupBackupCodes([]);
          setVerifyMode(preferRecoveryRef.current ? "recovery" : "authenticator");
          preferRecoveryRef.current = false;
          setPhase("totp-verify");
          return;
        }

        beginTotpSetup(profile.email);
      } catch (caught) {
        try {
          await signOutFirebase();
        } catch {
          // ignore
        }
        setError(explainFirebaseAuthError(caught));
        setPhase("sign-in");
      } finally {
        setBusy(false);
      }
  }, [beginTotpSetup]);

  const confirmTotpSetup = useCallback(
    async (code: string) => {
      if (!pendingProfile || !setupSecret || setupBackupCodes.length === 0) {
        setError("Setup expired. Sign in with Google again.");
        setPhase("sign-in");
        return false;
      }
      if (!verifyTotpCode(setupSecret, code)) {
        setError("Code did not match. Check Google Authenticator and try again.");
        return false;
      }

      setBusy(true);
      setError(null);
      try {
        const saved = await saveTotpRecordRemote(
          pendingProfile.email,
          setupSecret,
          setupBackupCodes,
        );
        if ((saved.backupCodeHashes?.length ?? 0) !== setupBackupCodes.length) {
          throw new Error("Recovery codes did not save correctly.");
        }
        clearAuthFailures(pendingProfile.email);
        finishAuth(pendingProfile);
        return true;
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not save 2FA setup to Firebase. Check Firestore rules.",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [finishAuth, pendingProfile, setupBackupCodes, setupSecret],
  );

  const verifyTotp = useCallback(
    async (code: string) => {
      if (!pendingProfile) {
        setError("Sign in with Google first.");
        setPhase("sign-in");
        return false;
      }

      const lock = isAuthLocked(pendingProfile.email);
      if (lock.locked && lock.until) {
        setError(lockoutMessage(lock.until));
        return false;
      }

      setBusy(true);
      setError(null);
      try {
        if (verifyMode === "recovery" || isBackupCodeInput(code)) {
          const ok = await consumeBackupCode(pendingProfile.email, code);
          if (!ok) {
            const failed = recordAuthFailure(pendingProfile.email);
            if (failed.locked && failed.until) {
              setError(lockoutMessage(failed.until));
            } else {
              setError("Invalid or already used recovery code.");
            }
            return false;
          }
          clearAuthFailures(pendingProfile.email);
          finishAuth(pendingProfile);
          return true;
        }

        let secret = storedTotpSecret;
        if (!secret) {
          const remote = await fetchTotpRecord(pendingProfile.email);
          if (!remote) {
            beginTotpSetup(pendingProfile.email);
            return false;
          }
          secret = remote.secret;
          setStoredTotpSecret(secret);
        }

        if (!verifyTotpCode(secret, code)) {
          const failed = recordAuthFailure(pendingProfile.email);
          if (failed.locked && failed.until) {
            setError(lockoutMessage(failed.until));
          } else {
            setError("Invalid Authenticator code. Try again or use a recovery code.");
          }
          return false;
        }

        clearAuthFailures(pendingProfile.email);
        finishAuth(pendingProfile);
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not verify 2FA.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [beginTotpSetup, finishAuth, pendingProfile, storedTotpSecret, verifyMode],
  );

  const requestRecoverySignIn = useCallback(() => {
    preferRecoveryRef.current = true;
    setError(null);
  }, []);

  const continueAfterRecoverySave = useCallback(() => {
    setSetupBackupCodes([]);
    setSetupMode("full");
    setPhase("totp-verify");
    setVerifyMode("authenticator");
    setError(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);
  const reportError = useCallback((message: string) => setError(message), []);

  return useMemo(
    () => ({
      phase,
      session,
      pendingProfile,
      error,
      busy,
      verifyMode,
      setupMode,
      setupSecret,
      setupUri,
      setupBackupCodes,
      signInWithGoogle,
      confirmTotpSetup,
      verifyTotp,
      setVerifyMode,
      requestRecoverySignIn,
      continueAfterRecoverySave,
      signOut,
      clearError,
      reportError,
    }),
    [
      phase,
      session,
      pendingProfile,
      error,
      busy,
      verifyMode,
      setupMode,
      setupSecret,
      setupUri,
      setupBackupCodes,
      signInWithGoogle,
      confirmTotpSetup,
      verifyTotp,
      continueAfterRecoverySave,
      requestRecoverySignIn,
      signOut,
      clearError,
      reportError,
    ],
  );
}
