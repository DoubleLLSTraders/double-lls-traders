import type { OptionsAccount } from "./types";

export interface RestClientOptions {
  appId: string;
  restUrl: string;
  token: string;
}

interface RawAccount {
  account_id: string;
  balance: string;
  currency: string;
  status: string;
  account_type: string;
}

function headers(options: RestClientOptions): HeadersInit {
  return {
    Authorization: `Bearer ${options.token}`,
    "Deriv-App-ID": options.appId,
    Accept: "application/json",
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & {
    message?: string;
    error?: string;
    errors?: Array<{ message?: string }>;
  };
  if (!response.ok) {
    const detail =
      body.message ??
      body.error ??
      body.errors?.[0]?.message ??
      `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return body;
}

export async function listAccounts(options: RestClientOptions): Promise<OptionsAccount[]> {
  const response = await fetch(`${options.restUrl}/trading/v1/options/accounts`, {
    headers: headers(options),
  });
  const body = await readJson<{ data: RawAccount[] }>(response);
  return (body.data ?? []).map((account) => ({
    accountId: account.account_id,
    balance: Number(account.balance),
    currency: account.currency,
    isVirtual: account.account_type === "demo",
    status: account.status,
  }));
}

/**
 * Mint a short-lived OTP and return the ready-to-use authenticated WebSocket URL.
 * OTPs expire quickly, so this must be called immediately before connecting.
 */
export async function requestSocketUrl(
  options: RestClientOptions,
  accountId: string,
): Promise<string> {
  const response = await fetch(
    `${options.restUrl}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    {
      method: "POST",
      headers: headers(options),
    },
  );
  const body = await readJson<{ data: { url: string } }>(response);
  if (!body.data?.url) throw new Error("OTP response did not include a WebSocket URL.");
  return body.data.url;
}

export async function resolveAccount(
  options: RestClientOptions,
  kind: "demo" | "real",
  preferredId?: string,
): Promise<OptionsAccount> {
  const accounts = await listAccounts(options);
  if (accounts.length === 0) {
    throw new Error("This token cannot see any Options accounts.");
  }

  const preferred = preferredId
    ? accounts.find((account) => account.accountId === preferredId)
    : undefined;
  if (preferred) return preferred;

  const match = accounts.find((account) => (kind === "demo" ? account.isVirtual : !account.isVirtual));
  if (match) return match;

  throw new Error(`No ${kind} Options account is visible to this token.`);
}
