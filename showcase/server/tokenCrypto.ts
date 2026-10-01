import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM with a 32-byte key given as base64 (CLOUD_BOT_KEY). Output: iv.tag.ciphertext, each base64url. */
function key(raw: string | undefined): Buffer {
  const k = Buffer.from((raw ?? "").trim(), "base64");
  if (k.length !== 32) throw new Error("CLOUD_BOT_KEY must be 32 bytes, base64 encoded.");
  return k;
}

export function encryptToken(token: string, rawKey: string | undefined): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(rawKey), iv);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decryptToken(sealed: string, rawKey: string | undefined): string {
  const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !data) throw new Error("Malformed token.");
  const decipher = createDecipheriv("aes-256-gcm", key(rawKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
