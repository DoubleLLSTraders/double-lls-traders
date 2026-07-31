/**
 * Diagnoses the new Options API: REST health, PAT account listing, OTP, and a
 * short public WebSocket ping.
 *
 *   npm run check-connection
 */
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");
const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const ACCOUNT_ID = process.env.VITE_DERIV_DEMO_ACCOUNT_ID?.trim() ?? "";

async function main() {
  console.log(`REST: ${REST_URL}`);
  console.log(`App ID: ${APP_ID || "(empty)"}`);

  const health = await fetch(`${REST_URL}/v1/health`);
  console.log(`Health: ${health.ok ? "OK" : `HTTP ${health.status}`}`);

  if (!APP_ID || !TOKEN) {
    console.error("Need VITE_DERIV_APP_ID and VITE_DERIV_TOKEN_DEMO in .env.");
    process.exit(1);
  }

  const accountsResponse = await fetch(`${REST_URL}/trading/v1/options/accounts`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Deriv-App-ID": APP_ID,
      Accept: "application/json",
    },
  });
  const accountsBody = (await accountsResponse.json()) as {
    data?: Array<{ account_id: string; account_type: string; balance: string }>;
    message?: string;
  };
  if (!accountsResponse.ok) {
    console.error(`Accounts failed: ${accountsBody.message ?? JSON.stringify(accountsBody)}`);
    process.exit(1);
  }
  console.log("Accounts:");
  for (const account of accountsBody.data ?? []) {
    console.log(`  ${account.account_id}  ${account.account_type}  ${account.balance}`);
  }

  const accountId =
    ACCOUNT_ID ||
    accountsBody.data?.find((account) => account.account_type === "demo")?.account_id;
  if (!accountId) {
    console.error("No demo account id available.");
    process.exit(1);
  }

  const otpResponse = await fetch(
    `${REST_URL}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
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
  console.log(`OTP URL: ${otpBody.data.url.replace(/otp=[^&]+/, "otp=***")}`);

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(otpBody.data!.url!);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket timed out."));
    }, 10_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ ping: 1, req_id: 1 }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { ping?: string; error?: { message: string } };
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(message.error.message));
      else if (message.ping === "pong") {
        console.log("WebSocket ping: OK");
        resolve();
      } else reject(new Error(`Unexpected reply: ${String(event.data).slice(0, 200)}`));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket transport error."));
    });
  });

  console.log("Connection check passed.");
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
