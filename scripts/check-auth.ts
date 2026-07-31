/**
 * Confirms the configured PAT against Deriv's new Options REST API and
 * reports whether the linked account is demo or real.
 *
 *   npm run check-auth
 */
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");
const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const ACCOUNT = process.env.VITE_DERIV_ACCOUNT?.trim() === "real" ? "real" : "demo";
const TOKEN =
  ACCOUNT === "real"
    ? process.env.VITE_DERIV_TOKEN_REAL?.trim()
    : process.env.VITE_DERIV_TOKEN_DEMO?.trim();

interface OptionsAccount {
  account_id: string;
  balance: string;
  currency: string;
  status: string;
  account_type: "demo" | "real" | string;
}

async function main() {
  console.log(`Account mode from .env: ${ACCOUNT}`);
  console.log(`App ID: ${APP_ID || "(empty)"}`);
  console.log(`REST: ${REST_URL}`);

  if (!APP_ID) {
    console.error("VITE_DERIV_APP_ID is empty.");
    process.exit(1);
  }
  if (!TOKEN) {
    console.error(`No token set for ${ACCOUNT}.`);
    process.exit(1);
  }
  console.log(`Token present: yes (length ${TOKEN.length}, ends …${TOKEN.slice(-4)})`);

  const response = await fetch(`${REST_URL}/trading/v1/options/accounts`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Deriv-App-ID": APP_ID,
      Accept: "application/json",
    },
  });

  const body = (await response.json()) as {
    data?: OptionsAccount[];
    message?: string;
    error?: string;
  };

  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${body.message ?? body.error ?? JSON.stringify(body)}`);
    process.exit(1);
  }

  const accounts = body.data ?? [];
  console.log(`Accounts visible to this token: ${accounts.length}`);
  for (const account of accounts) {
    console.log(
      `  ${account.account_id}  type=${account.account_type}  balance=${account.balance} ${account.currency}  status=${account.status}`,
    );
  }

  const preferredId =
    ACCOUNT === "demo"
      ? process.env.VITE_DERIV_DEMO_ACCOUNT_ID?.trim()
      : process.env.VITE_DERIV_REAL_ACCOUNT_ID?.trim();

  const selected =
    (preferredId ? accounts.find((account) => account.account_id === preferredId) : undefined) ??
    accounts.find((account) => account.account_type === ACCOUNT) ??
    accounts[0];

  if (!selected) {
    console.error("No accounts returned for this token.");
    process.exit(1);
  }

  const isDemo = selected.account_type === "demo";
  console.log(`Selected: ${selected.account_id} → ${isDemo ? "DEMO" : "REAL"}`);

  if (ACCOUNT === "demo" && !isDemo) {
    console.error("Expected a demo account but selected a real one.");
    process.exit(2);
  }

  const otpResponse = await fetch(
    `${REST_URL}/trading/v1/options/accounts/${encodeURIComponent(selected.account_id)}/otp`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Deriv-App-ID": APP_ID,
        Accept: "application/json",
      },
    },
  );
  const otpBody = (await otpResponse.json()) as { data?: { url?: string }; message?: string };
  if (!otpResponse.ok || !otpBody.data?.url) {
    console.error(`OTP failed: ${otpBody.message ?? JSON.stringify(otpBody)}`);
    process.exit(1);
  }
  console.log(`WebSocket OTP URL issued: ${otpBody.data.url.replace(/otp=[^&]+/, "otp=***")}`);
  console.log(isDemo ? "Confirmed: demo account + working PAT." : "Confirmed: real account + working PAT.");
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
