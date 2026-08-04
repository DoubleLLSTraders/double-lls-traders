import {
  ATLAS_DEMO_START,
  syncLedger,
} from "../src/hubs/atlas/ledger";

const { trades, account } = syncLedger(
  [
    {
      id: "t1",
      at: 1,
      symbol: "frxXAUUSD",
      side: "sell",
      entry: 4000,
      stop: 4010,
      target: 3980,
      result: "win",
      pnlR: 2,
      reason: "test",
      paper: true,
    },
  ],
  2,
  "USD",
  ATLAS_DEMO_START,
);

if (trades[0].pnlCash !== 4) {
  console.error("expected pnlCash 4 got", trades[0].pnlCash);
  process.exit(1);
}
if (account.balance !== 10004) {
  console.error("expected balance 10004 got", account.balance);
  process.exit(1);
}
console.log("PASS: win +4 books balance to 10004");
