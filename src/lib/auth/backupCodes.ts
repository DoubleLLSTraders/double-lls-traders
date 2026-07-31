import { APP_NAME } from "./constants";

const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_COUNT = 8;
const CODE_LENGTH = 8;

function randomCharsetIndex(): number {
  const bytes = new Uint8Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % CHARSET.length;
}

function randomBackupCode(): string {
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    raw += CHARSET[randomCharsetIndex()];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeBackupCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

export function formatBackupCode(input: string): string {
  const raw = normalizeBackupCode(input);
  if (raw.length !== CODE_LENGTH) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function isValidBackupCode(input: string): boolean {
  const raw = normalizeBackupCode(input);
  return raw.length === CODE_LENGTH && /^[A-Z2-9]{8}$/.test(raw);
}

export function generateBackupCodes(count = CODE_COUNT): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];

  while (codes.length < count) {
    const code = randomBackupCode();
    const key = normalizeBackupCode(code);
    if (seen.has(key)) continue;
    seen.add(key);
    codes.push(code);
  }

  return validateBackupCodeBatch(codes);
}

export function validateBackupCodeBatch(codes: string[]): string[] {
  if (codes.length !== CODE_COUNT) {
    throw new Error(`Expected ${CODE_COUNT} recovery codes.`);
  }

  const formatted = codes.map((code) => formatBackupCode(code));
  const unique = new Set(formatted.map((code) => normalizeBackupCode(code)));

  if (unique.size !== CODE_COUNT) {
    throw new Error("Recovery codes must all be unique.");
  }

  for (const code of formatted) {
    if (!isValidBackupCode(code)) {
      throw new Error("Invalid recovery code format.");
    }
  }

  return formatted;
}

export function isBackupCodeInput(input: string): boolean {
  return isValidBackupCode(input);
}

export function backupCodeMatches(stored: string, entered: string): boolean {
  return normalizeBackupCode(stored) === normalizeBackupCode(entered);
}

export function downloadBackupCodesFile(email: string, codes: string[]): void {
  const safeCodes = validateBackupCodeBatch(codes);
  const lines = [
    `${APP_NAME} — 2FA recovery codes (CONFIDENTIAL)`,
    `Account: ${email}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "Each code works once. Store this file somewhere safe (not on this phone).",
    "If you lose Google Authenticator, sign in with Google and enter one code below.",
    "",
    ...safeCodes.map((code, index) => `${index + 1}. ${code}`),
    "",
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "double-lls-traders-recovery-codes.txt";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
