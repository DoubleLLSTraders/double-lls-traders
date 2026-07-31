/** Platform identity — display name vs internal storage keys. */
export const APP_NAME = "Double LLS Traders";
export const APP_TAGLINE = "Institutional-grade Deriv Matches / Differs desk";
export const APP_SHORT = "LLS";

/** Google accounts allowed to sign in. */
export const ALLOWED_EMAILS = [
  "munyivaemmanuel@gmail.com",
  "josephokero074@gmail.com",
] as const;

export const AUTH_SESSION_KEY = "brick-trader-auth-session";
export const AUTH_LOCKOUT_KEY = "double-lls-auth-lockout";
export const AUTH_FAIL_KEY = "double-lls-auth-fails";

/** How long a full sign-in (Google + TOTP) stays valid. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Lock out after this many failed 2FA attempts. */
export const MAX_AUTH_FAILURES = 5;

/** Lockout duration after too many failures. */
export const AUTH_LOCKOUT_MS = 15 * 60 * 1000;

export const APP_AUTH_NAME = APP_NAME;
