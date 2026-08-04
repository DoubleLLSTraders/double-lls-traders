import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { CUSTOM_DOMAIN, GITHUB_PAGES_HOST } from "../platform";
import { getFirebaseApp, readFirebaseConfig } from "./config";

/** Firebase Console → Authentication → Settings (authorized domains). */
export function getFirebaseAuthSettingsUrl(): string | null {
  const projectId = readFirebaseConfig()?.projectId;
  if (!projectId) return null;
  return `https://console.firebase.google.com/project/${encodeURIComponent(projectId)}/authentication/settings`;
}

/** Domains that must appear under Firebase Auth → Authorized domains. */
export function requiredFirebaseAuthDomains(): string[] {
  const domains = ["localhost", GITHUB_PAGES_HOST, CUSTOM_DOMAIN];
  if (typeof window !== "undefined" && window.location.hostname) {
    domains.push(window.location.hostname);
  }
  return [...new Set(domains)];
}

export function isFirebaseUnauthorizedDomainError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("auth/unauthorized-domain");
}

export function isFirebaseUnauthorizedDomainMessage(message: string): boolean {
  return message.includes("Authorized domains") || message.includes("not authorized in Firebase");
}

/** Wait until Firebase Auth finishes restoring persistence (or times out). */
export function waitForFirebaseAuth(timeoutMs = 8000): Promise<User | null> {
  const auth = getAuth(getFirebaseApp());
  if (auth.currentUser) return Promise.resolve(auth.currentUser);

  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      unsub();
      resolve(auth.currentUser);
    }, timeoutMs);

    const unsub = onAuthStateChanged(auth, (user) => {
      window.clearTimeout(timer);
      unsub();
      resolve(user);
    });
  });
}

export async function signInWithGooglePopup(): Promise<User> {
  const auth = getAuth(getFirebaseApp());
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOutFirebase(): Promise<void> {
  const auth = getAuth(getFirebaseApp());
  await signOut(auth);
}

export function getFirebaseUserEmail(): string | null {
  return getAuth(getFirebaseApp()).currentUser?.email?.trim().toLowerCase() ?? null;
}

/** Session is valid only when Firebase Auth matches the signed-in operator email. */
export function firebaseMatchesEmail(email: string): boolean {
  const current = getFirebaseUserEmail();
  return current !== null && current === email.trim().toLowerCase();
}

/** Turn Firebase Auth errors into operator-facing setup hints. */
export function explainFirebaseAuthError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (
    msg.includes("auth/invalid-credential") ||
    msg.includes("not authorized to be used in the project") ||
    msg.includes("Invalid Idp Response")
  ) {
    return (
      "Google sign-in is not linked to this Firebase project. " +
      "Open Firebase Console → Authentication → Sign-in method → Google, enable it, " +
      "then add localhost under Authentication → Settings → Authorized domains."
    );
  }
  if (msg.includes("auth/popup-closed-by-user")) {
    return "Google sign-in was cancelled.";
  }
  if (msg.includes("auth/popup-blocked")) {
    return "Pop-up blocked. Allow pop-ups for this site and try again.";
  }
  if (msg.includes("auth/unauthorized-domain")) {
    const host = typeof window !== "undefined" ? window.location.hostname : GITHUB_PAGES_HOST;
    const project = readFirebaseConfig()?.projectId ?? "your Firebase project";
    return `Add "${host}" to Firebase Authorized domains (project: ${project}). Use the link below, click Add domain, save, then try again.`;
  }
  return msg || "Google sign-in failed.";
}
