import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signOut,
  type User,
} from "firebase/auth";
import { getFirebaseApp } from "./config";

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

export async function signInFirebaseWithGoogle(idToken: string): Promise<User> {
  const auth = getAuth(getFirebaseApp());
  const credential = GoogleAuthProvider.credential(idToken);
  const result = await signInWithCredential(auth, credential);
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
      "Google OAuth client does not match your Firebase project. " +
      "In Firebase Console → Authentication → Sign-in method → Google: enable Google, copy the Web client ID shown there, " +
      "paste it into VITE_GOOGLE_CLIENT_ID in .env, restart the dev server, and add http://localhost:5173 to that client's authorized origins."
    );
  }
  return msg || "Google sign-in failed.";
}
