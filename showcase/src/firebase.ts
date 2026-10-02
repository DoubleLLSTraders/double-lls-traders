import { initializeApp } from "firebase/app";
import {
  EmailAuthProvider,
  applyActionCode,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
  reauthenticateWithCredential,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  verifyPasswordResetCode,
  type User,
} from "firebase/auth";

/** Public web config of the llsbot-malimines Firebase project; these values are meant to ship to browsers. */
const app = initializeApp({
  apiKey: "AIzaSyCQdOJnJgybshD0ryu48kCr4vdnf7Z66Cw",
  authDomain: "llsbot-malimines.firebaseapp.com",
  projectId: "llsbot-malimines",
  appId: "1:1042629092100:web:9021009ecfe53862a86651",
  messagingSenderId: "1042629092100",
});
const auth = getAuth(app);
auth.useDeviceLanguage();

const continueUrl = () => ({ url: `${location.origin}/#/account` });

const MESSAGES: Record<string, string> = {
  "auth/invalid-credential": "Wrong email or password.",
  "auth/wrong-password": "Wrong password.",
  "auth/user-not-found": "Wrong email or password.",
  "auth/invalid-email": "Enter a valid email.",
  "auth/email-already-in-use": "That email already has an account. Sign in instead.",
  "auth/weak-password": "Use a password of at least 8 characters.",
  "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
  "auth/network-request-failed": "No connection. Check your internet and try again.",
  "auth/requires-recent-login": "For your security, sign in again first.",
  "auth/expired-action-code": "This link has expired. Ask for a new one.",
  "auth/invalid-action-code": "This link is not valid any more. It may have been used already.",
  "auth/user-disabled": "This account has been disabled. Contact support@malimines.com.",
};

export const authCode = (err: unknown) => (err as { code?: string })?.code ?? "";

/** Firebase errors turned into plain sentences; anything else passes through. */
export function friendly(err: unknown) {
  const code = authCode(err);
  return MESSAGES[code] ?? (err instanceof Error ? err.message.replace(/^Firebase: /, "").replace(/ \(auth\/[\w-]+\)\.?$/, "") : "Something went wrong.");
}

async function sendVerification(user: User) {
  try {
    await sendEmailVerification(user, continueUrl());
  } catch (err) {
    if (authCode(err) !== "auth/unauthorized-continue-uri") throw err;
    await sendEmailVerification(user);
  }
}

export async function firebaseSignUp(email: string, password: string) {
  const { user } = await createUserWithEmailAndPassword(auth, email, password);
  await sendVerification(user).catch(() => {});
  return user.getIdToken();
}

export async function firebaseSignIn(email: string, password: string) {
  const { user } = await signInWithEmailAndPassword(auth, email, password);
  return user.getIdToken();
}

/** Moves an account that still uses the old site password into Firebase, keeping the same password. */
export async function firebaseAdopt(email: string, password: string) {
  try {
    return await firebaseSignUp(email, password);
  } catch (err) {
    if (authCode(err) === "auth/email-already-in-use") return firebaseSignIn(email, password);
    throw err;
  }
}

/** Fresh ID token for the signed-in Firebase user after reloading, so email_verified is current. */
export async function freshIdToken() {
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) return null;
  await user.reload();
  return { token: await user.getIdToken(true), verified: user.emailVerified };
}

/** Cheap check for polling: reloads the Firebase user without minting a new ID token. */
export async function isEmailVerified() {
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) return false;
  await user.reload();
  return user.emailVerified;
}

export async function resendVerification() {
  await auth.authStateReady();
  if (!auth.currentUser) throw new Error("Sign out and sign in again, and we will send you a fresh link.");
  await sendVerification(auth.currentUser);
}

export async function sendReset(email: string) {
  try {
    await sendPasswordResetEmail(auth, email, continueUrl());
  } catch (err) {
    if (authCode(err) === "auth/unauthorized-continue-uri") await sendPasswordResetEmail(auth, email);
    else if (authCode(err) !== "auth/user-not-found") throw err;
  }
}

export async function changePassword(email: string, current: string, next: string) {
  await auth.authStateReady();
  const user = auth.currentUser ?? (await signInWithEmailAndPassword(auth, email, current)).user;
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(email, current));
  await updatePassword(user, next);
}

export async function firebaseSignOut() {
  await signOut(auth).catch(() => {});
}

export async function firebaseDelete(email: string, password: string) {
  await auth.authStateReady();
  const user = auth.currentUser ?? (await signInWithEmailAndPassword(auth, email, password)).user;
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(email, password));
  await deleteUser(user);
}

/** Email links (verify / reset) when the action URL points at this site: ?mode=…&oobCode=… */
export const checkResetCode = (code: string) => verifyPasswordResetCode(auth, code);
export const finishReset = (code: string, password: string) => confirmPasswordReset(auth, code, password);
export const applyEmailCode = (code: string) => applyActionCode(auth, code);
