import type { User } from "firebase/auth";
import { ALLOWED_EMAILS } from "./constants";

export interface GoogleProfile {
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
}

function decodeJwtPayload(credential: string): Record<string, unknown> {
  const segment = credential.split(".")[1];
  if (!segment) throw new Error("Invalid Google credential.");
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(normalized);
  return JSON.parse(json) as Record<string, unknown>;
}

/** Legacy JWT parse — prefer profileFromFirebaseUser after Firebase popup sign-in. */
export function parseGoogleCredential(credential: string): GoogleProfile {
  const payload = decodeJwtPayload(credential);
  const email = String(payload.email ?? "").trim().toLowerCase();
  const name = String(payload.name ?? email).trim();
  const picture = typeof payload.picture === "string" ? payload.picture : undefined;
  const emailVerified = payload.email_verified === true;

  if (!email) throw new Error("Google did not return an email address.");
  if (!emailVerified) throw new Error("Verify this Google account's email before signing in.");

  return { email, name, picture, emailVerified };
}

export function profileFromFirebaseUser(user: User): GoogleProfile {
  const email = user.email?.trim().toLowerCase() ?? "";
  if (!email) throw new Error("Google did not return an email address.");
  if (!user.emailVerified) {
    throw new Error("Verify this Google account's email before signing in.");
  }
  return {
    email,
    name: user.displayName?.trim() || email,
    picture: user.photoURL ?? undefined,
    emailVerified: true,
  };
}

export function isAllowedEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return ALLOWED_EMAILS.some((allowed) => allowed === normalized);
}

export function googleClientId(): string {
  return (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "").trim();
}

export function isGoogleAuthConfigured(): boolean {
  return googleClientId().length > 0;
}
