/** Sanity checks after a bot change: simulated-market backtests, risk features, survival test and generated bot files. */
import { writeFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, type BotSettings } from "../src/bot";
import { runBacktest } from "../src/backtest";
import { buildExport } from "../src/exports";
import { runSurvival } from "../src/survival";

const ALL_ON: BotSettings = { ...DEFAULT_SETTINGS, kellySizing: true, drawdownBrake: 5, dailyLossLimit: 500, randomnessFilter: true, regimeGuard: true };

for (const [name, settings] of [["default", DEFAULT_SETTINGS], ["all-on", ALL_ON]] as const) {
  for (const regime of ["pattern", "fair"] as const) {
    const r = runBacktest(regime, settings, 30_000, 7);
    console.log(`${name.padEnd(8)} ${regime.padEnd(8)} trades=${r.trades} win=${r.winRate.toFixed(1)}% pnl=${r.pnl.toFixed(2)} maxDD=${r.maxDrawdown.toFixed(2)}`);
  }
}

for (const [name, settings] of [["default", DEFAULT_SETTINGS], ["all-on", ALL_ON]] as const) {
  const started = Date.now();
  const r = await runSurvival(settings, () => {}, { cancelled: false });
  console.log(`survival ${name}: ${JSON.stringify(r, (_, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v))} in ${Date.now() - started}ms`);
}

for (const [format, file] of [["javascript", "tmp-bot.mjs"], ["python", "tmp-bot.py"]] as const) {
  const { text } = buildExport(format, ALL_ON);
  await writeFile(`scripts/${file}`, text);
  console.log(`wrote scripts/${file} (${text.length} chars)`);
}
