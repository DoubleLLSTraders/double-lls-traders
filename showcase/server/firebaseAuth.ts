import { createPublicKey, verify, type KeyObject } from "node:crypto";

const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const SKEW_S = 300;

export interface DecodedIdToken {
  uid: string;
  email?: string;
  email_verified?: boolean;
  [claim: string]: unknown;
}

let certs: { keys: Map<string, KeyObject>; expires: number } | null = null;

async function signingKey(kid: string): Promise<KeyObject | undefined> {
  if (!certs || Date.now() >= certs.expires || !certs.keys.has(kid)) {
    const res = await fetch(CERTS_URL);
    if (!res.ok) throw new Error(`Could not load Firebase signing keys (${res.status}).`);
    const pem = (await res.json()) as Record<string, string>;
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
    certs = { keys: new Map(Object.entries(pem).map(([id, cert]) => [id, createPublicKey(cert)])), expires: Date.now() + maxAge * 1000 };
  }
  return certs.keys.get(kid);
}

const part = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;

/**
 * Checks a Firebase Authentication ID token from the browser against Google's public signing keys.
 * Done by hand rather than with firebase-admin, whose verifier cannot load on the Netlify runtime.
 */
export async function verifyFirebaseIdToken(env: Record<string, string | undefined>, idToken: string): Promise<DecodedIdToken> {
  const projectId = env.FIREBASE_AUTH_PROJECT_ID || "llsbot-malimines";
  const [h, p, s] = idToken.split(".");
  if (!h || !p || !s) throw new Error("Malformed token.");
  const header = part(h);
  const claims = part(p);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unexpected token header.");
  const key = await signingKey(header.kid);
  if (!key || !verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) throw new Error("Bad token signature.");

  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== projectId) throw new Error("Token is for another project.");
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Token has the wrong issuer.");
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) throw new Error("Token expired.");
  if (typeof claims.iat !== "number" || claims.iat - SKEW_S > now) throw new Error("Token issued in the future.");
  if (typeof claims.auth_time !== "number" || claims.auth_time - SKEW_S > now) throw new Error("Bad auth time.");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128) throw new Error("Token has no user.");
  return { ...claims, uid: claims.sub } as DecodedIdToken;
}
