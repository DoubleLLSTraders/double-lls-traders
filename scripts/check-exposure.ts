/**
 * Sanity-checks the per-trade exposure ceiling.
 *
 *   npm run check-exposure
 *
 * Pure arithmetic, no network. Confirms that the cap shrinks with the balance,
 * that it overrides a martingale rung, and that it refuses to trade when the
 * smallest legal basket would breach it.
 */
import { MIN_STAKE, capStake, exposureCap } from "../src/lib/bot/gates";

interface Row {
  name: string;
  balance: number | null;
  pct: number;
  legs: number;
  wants: number;
}

const rows: Row[] = [
  { name: "live account now", balance: 0.82, pct: 2, legs: 1, wants: 1.75 },
  { name: "live, 5 legs", balance: 0.82, pct: 2, legs: 5, wants: 1.75 },
  { name: "the 5.50 wipeout", balance: 5.5, pct: 2, legs: 1, wants: 5.0 },
  { name: "small account", balance: 50, pct: 2, legs: 1, wants: 1.75 },
  { name: "martingale rung", balance: 50, pct: 2, legs: 1, wants: 20.0 },
  { name: "demo account", balance: 9969, pct: 2, legs: 1, wants: 1.75 },
  { name: "cap disabled", balance: 0.82, pct: 0, legs: 1, wants: 5.0 },
  { name: "no balance yet", balance: null, pct: 2, legs: 1, wants: 1.75 },
  // Settings saved before the field existed read back undefined.
  { name: "pre-upgrade save", balance: 50, pct: undefined as never, legs: 1, wants: 1.75 },
];

console.log(`Deriv minimum stake: ${MIN_STAKE}\n`);
console.log("  scenario           balance    cap  legs    wants   budget   risked  status");
console.log("  ──────────────────────────────────────────────────────────────────────────────");

for (const row of rows) {
  const settings = { contracts: row.legs, maxExposurePercent: row.pct };
  const cap = exposureCap(settings, row.balance);
  const stake = capStake(row.wants, settings, row.balance);
  const risked = stake * row.legs;
  const status = !cap ? "uncapped" : cap.affordable ? "ok" : "BLOCKED";
  const share =
    row.balance && row.balance > 0 ? ` (${((risked / row.balance) * 100).toFixed(1)}%)` : "";

  console.log(
    `  ${row.name.padEnd(18)} ${String(row.balance ?? "—").padStart(7)} ${`${
      row.pct === undefined ? "unset" : `${row.pct}%`
    }`.padStart(
      6,
    )} ${String(row.legs).padStart(5)} ${row.wants.toFixed(2).padStart(8)} ${(cap
      ? cap.budget.toFixed(2)
      : "—"
    ).padStart(8)} ${(status === "BLOCKED" ? "—" : risked.toFixed(2)).padStart(8)}  ${status}${
      status === "ok" ? share : ""
    }`,
  );
}

console.log(
  "\n  BLOCKED means the gate refuses the trade outright — the smallest basket\n" +
    "  Deriv will accept is already more of the account than the cap allows.",
);
