/**
 * Lists every Options account the configured token can reach, so the account
 * switcher knows whether a real account is actually available.
 * Read-only: places no orders.
 *
 *   npm run check-accounts
 */
import { listAccounts } from "../src/lib/deriv/rest";

const appId = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const restUrl = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");

const TOKENS: Array<[label: string, token: string]> = [
  ["VITE_DERIV_TOKEN_DEMO", process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? ""],
  ["VITE_DERIV_TOKEN_REAL", process.env.VITE_DERIV_TOKEN_REAL?.trim() ?? ""],
];

async function report(label: string, token: string) {
  console.log(`\n=== ${label} ===`);
  if (!token) {
    console.log("  not set");
    return;
  }
  try {
    const accounts = await listAccounts({ appId, restUrl, token });
    for (const account of accounts) {
      console.log(
        `  ${account.accountId.padEnd(14)} ${(account.isVirtual ? "demo" : "REAL").padEnd(
          5,
        )} ${account.balance.toFixed(2).padStart(12)} ${account.currency.padEnd(4)} ${account.status}`,
      );
    }
    const real = accounts.filter((a) => !a.isVirtual);
    console.log(
      `  → ${real.length > 0 ? "real account reachable" : "no real account on this token"}`,
    );
  } catch (error) {
    console.log(`  FAILED · ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  for (const [label, token] of TOKENS) await report(label, token);
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
