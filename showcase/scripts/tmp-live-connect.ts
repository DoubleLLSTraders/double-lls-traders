import { DEFAULT_SETTINGS } from "../src/bot";
import { LiveRunner } from "../worker/liveRunner";

const runner = new LiveRunner({
  settings: { ...DEFAULT_SETTINGS, minWinRate: 100, minConfidence: 99 },
  token: process.env.DERIV_TOKEN!,
  allowReal: false,
  appId: process.env.DERIV_APP_ID!,
  onChange: () => {},
  log: (m) => console.log("runner:", m),
});
runner.start();
const deadline = Date.now() + 30_000;
while (runner.status.state !== "running" && runner.status.state !== "error" && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
}
await new Promise((r) => setTimeout(r, 5000));
const s = runner.status;
console.log(`state=${s.state} message="${s.message}" demo=${s.isVirtual} currency=${s.currency} balance>0=${s.balance > 0} trades=${s.trades}`);
runner.stop("done");
process.exit(0);
