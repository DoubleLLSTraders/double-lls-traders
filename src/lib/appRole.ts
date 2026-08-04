/**
 * Client vs admin entry.
 *
 * Client: public Over/Under desk + Deriv OAuth.
 * Admin: /admin (or admin.* host) + Google allowlist + TOTP + full platform.
 */

export type AppRole = "client" | "admin";

function pathIsAdmin(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  // /admin, /admin.html, /…/admin, /…/admin.html, /…/admin/…
  if (/(?:^|\/)admin(?:\.html)?$/i.test(path)) return true;
  if (/(?:^|\/)admin\//i.test(path)) return true;
  return false;
}

function hostIsAdmin(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "admin" || host.startsWith("admin.");
}

/** Resolve role from the current browser location. */
export function resolveAppRole(
  loc: Pick<Location, "hostname" | "pathname"> = window.location,
): AppRole {
  if (hostIsAdmin(loc.hostname)) return "admin";
  if (pathIsAdmin(loc.pathname)) return "admin";
  return "client";
}

let cached: AppRole | null = null;

export function getAppRole(): AppRole {
  if (cached === null) {
    cached =
      typeof window === "undefined" ? "client" : resolveAppRole(window.location);
  }
  return cached;
}

export function isClientRole(): boolean {
  return getAppRole() === "client";
}

export function isAdminRole(): boolean {
  return getAppRole() === "admin";
}
