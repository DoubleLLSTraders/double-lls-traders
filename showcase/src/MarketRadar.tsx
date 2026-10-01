import type { DigitBot } from "./bot";
import { REAL_SYMBOLS, type Tick } from "./market";

interface MarketRadarProps {
  bot: DigitBot;
  series: Map<string, Tick[]>;
}

/** Every live index at a glance: signal strength, last digit, and which one the bot is trading. */
export function MarketRadar({ bot, series }: MarketRadarProps) {
  const views = new Map(bot.marketViews.map((v) => [v.market, v.scan]));
  const positions = new Map(bot.state.positions.map((p) => [p.market, p]));
  return (
    <div className="radar" role="list" aria-label="Markets the bot is watching">
      {REAL_SYMBOLS.map((m) => {
        const scan = views.get(m.id);
        const ticks = series.get(m.id);
        const last = ticks?.[ticks.length - 1];
        const top = scan?.candidates[0] ?? null;
        const open = positions.get(m.id);
        const trading = !!open;
        const signal = !!scan?.best;
        const strength = Math.max(0, Math.min(100, ((top?.confidence ?? 0) / 4) * 100));
        const state = open ? `${open.label}${open.units > 1 ? ` ×${open.units}` : ""}` : signal ? scan!.best!.label : top ? top.label : "Loading";
        return (
          <div
            key={m.id}
            role="listitem"
            className={`radar-cell${bot.focus === m.id ? " focus" : ""}${trading ? " trading" : signal ? " signal" : ""}${scan ? "" : " idle"}`}
            title={`${m.name}${top ? ` · ${top.label} ${top.winRate.toFixed(1)}% (needs ${top.breakEven.toFixed(1)}%)` : ""}`}
          >
            <div className="radar-top">
              <span className="radar-name">{m.short}</span>
              <span key={last?.epoch} className="radar-digit">{last?.digit ?? "–"}</span>
            </div>
            <div className="radar-bar"><i style={{ width: `${strength}%` }} /></div>
            <span className="radar-state">{state}</span>
          </div>
        );
      })}
    </div>
  );
}
