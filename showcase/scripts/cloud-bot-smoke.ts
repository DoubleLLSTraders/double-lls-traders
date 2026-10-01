/** Cloud bot checks that need no Google account: token sealing, the live runner against Deriv, and live-mode settlement. */
import { randomBytes } from "node:crypto";
import { DEFAULT_SETTINGS, DigitBot } from "../src/bot";
import { DemoMarket } from "../src/market";
import { decryptToken, encryptToken } from "../server/tokenCrypto";
import { LiveRunner } from "../worker/liveRunner";

const key = randomBytes(32).toString("base64");
const sealed = encryptToken("demoToken123", key);
console.log("token round trip:", decryptToken(sealed, key) === "demoToken123" ? "ok" : "FAILED");
try {
  decryptToken(sealed, randomBytes(32).toString("base64"));
  console.log("wrong key: FAILED (decrypted)");
} catch {
  console.log("wrong key rejected: ok");
}

const bot = new DigitBot({ ...DEFAULT_SETTINGS, mode: "differs", minWinRate: 0, minConfidence: 0, persistTicks: 0 });
bot.live = true;
bot.start();
const market = new DemoMarket("fair", 1);
let opened = 0;
for (let i = 0; i < 2000 && !bot.state.positions.length; i++) bot.onTick(market.next());
opened = bot.state.positions.length;
const open = bot.state.positions[0];
for (let i = 0; i < 5; i++) bot.onTick(market.next());
const stillOpen = bot.state.positions.length === opened;
if (open) bot.settleLive(open, -open.stake, 3, 99999);
console.log(`live mode: opened ${opened}, held open across ticks ${stillOpen ? "ok" : "FAILED"}, settled trades ${bot.state.trades}, pnl ${bot.state.pnl}`);

const runner = new LiveRunner({
  settings: DEFAULT_SETTINGS,
  token: "not-a-real-token",
  allowReal: false,
  appId: process.env.DERIV_APP_ID || "1089",
  onChange: () => {},
  log: (m) => console.log("runner:", m),
});
runner.start();
const deadline = Date.now() + 20_000;
while (runner.status.state !== "error" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
console.log(`runner with a bad token: state=${runner.status.state} message="${runner.status.message}"`);
runner.stop("done");
process.exit(0);
