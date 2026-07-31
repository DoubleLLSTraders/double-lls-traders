import { doc, getDoc, setDoc } from "firebase/firestore";
import { normalizeBackupCode, validateBackupCodeBatch } from "./backupCodes";
import { hashBackupCode } from "./security";
import { getFirestoreDb } from "../firebase/config";
import type { TotpRecord } from "./store";

const COLLECTION = "totp_secrets";

function docId(email: string): string {
  return email.trim().toLowerCase();
}

async function hashCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => hashBackupCode(code)));
}

function parseRecord(data: Record<string, unknown>): TotpRecord | null {
  const secret = typeof data.secret === "string" ? data.secret : "";
  const setupAt = typeof data.setupAt === "number" ? data.setupAt : 0;
  if (!secret) return null;

  const backupCodeHashes = Array.isArray(data.backupCodeHashes)
    ? data.backupCodeHashes.filter((hash): hash is string => typeof hash === "string")
    : [];

  return { secret, setupAt, backupCodeHashes };
}

export async function fetchTotpRecord(email: string): Promise<TotpRecord | null> {
  const ref = doc(getFirestoreDb(), COLLECTION, docId(email));
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return parseRecord(snap.data());
}

export async function saveTotpRecordRemote(
  email: string,
  secret: string,
  backupCodes: string[],
): Promise<TotpRecord> {
  const safeCodes = validateBackupCodeBatch(backupCodes);
  const backupCodeHashes = await hashCodes(safeCodes);
  const record: TotpRecord = { secret, setupAt: Date.now(), backupCodeHashes };
  const ref = doc(getFirestoreDb(), COLLECTION, docId(email));

  await setDoc(ref, record);

  const saved = await getDoc(ref);
  if (!saved.exists()) {
    throw new Error("Could not confirm 2FA save in Firebase.");
  }

  const parsed = parseRecord(saved.data());
  if (!parsed) {
    throw new Error("Saved 2FA record is invalid.");
  }
  if ((parsed.backupCodeHashes?.length ?? 0) !== backupCodeHashes.length) {
    throw new Error("Recovery codes did not save correctly. Try again.");
  }

  return parsed;
}

export async function consumeBackupCode(email: string, entered: string): Promise<boolean> {
  const ref = doc(getFirestoreDb(), COLLECTION, docId(email));
  const snap = await getDoc(ref);
  if (!snap.exists()) return false;

  const record = parseRecord(snap.data());
  if (!record?.backupCodeHashes?.length) return false;

  const enteredHash = await hashBackupCode(normalizeBackupCode(entered));
  const index = record.backupCodeHashes.findIndex((hash) => hash === enteredHash);
  if (index < 0) return false;

  const remaining = record.backupCodeHashes.filter((_, i) => i !== index);
  await setDoc(ref, { ...record, backupCodeHashes: remaining });

  const check = await getDoc(ref);
  const after = parseRecord(check.data() ?? {});
  if (!after || (after.backupCodeHashes?.length ?? 0) !== remaining.length) {
    throw new Error("Recovery code was used but Firebase did not update.");
  }

  return true;
}

/** True when 2FA is configured (has TOTP secret). */
export function hasTotpConfigured(record: TotpRecord | null): boolean {
  return record !== null && record.secret.length > 0;
}

/** True when hashed recovery codes exist in Firebase. */
export function hasRecoveryCodes(record: TotpRecord | null): boolean {
  return (record?.backupCodeHashes?.length ?? 0) > 0;
}
