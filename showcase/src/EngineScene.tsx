import type { DigitBot } from "./bot";
import { BOT_NAME } from "./exports";
import { MARKET_SYMBOL } from "./market";
import { Sparkline } from "./Sparkline";
import { pct, signedUsd, usd } from "./ui";

export function EngineScene({ bot }: { bot: DigitBot }) {
  const s = bot.state;
  const last = s.journal[0] ?? null;
  const top = bot.scan.candidates.slice(0, 3);
  const winRate = s.trades ? (s.wins / s.trades) * 100 : 0;

  return (
    <div className="scene">
      <div className="slab slab-back">
        <div className="slab-title">
          <span>{BOT_NAME} · scanner</span>
          <span className="slab-dim">{bot.scan.sample} ticks</span>
        </div>
        {top.length === 0 && <div className="slab-row"><span className="slab-dim">Collecting ticks…</span></div>}
        {top.map((c) => (
          <div key={c.label} className={`slab-row ${c.ready ? "ready" : ""}`}>
            <span className="slab-badge">{c.setup.barrier ?? (c.setup.contract === "DIGITEVEN" ? "E" : "O")}</span>
            <span className="slab-row-name">{c.label}</span>
            <span className="slab-row-val">{pct(c.winRate)} <i>›</i></span>
          </div>
        ))}
      </div>

      <div className="slab slab-front">
        <div className="slab-head">
          <span className="slab-heading">Run details</span>
          <span className="slab-dim">{MARKET_SYMBOL} · simulated balance</span>
        </div>
        <div className="slab-chips">
          <div className="chip-raised"><label>Balance</label><strong>{usd(s.balance)}</strong></div>
          <div className="chip-raised"><label>Profit</label><strong className={s.pnl >= 0 ? "up" : "down"}>{signedUsd(s.pnl)}</strong></div>
          <div className="chip-raised"><label>Win rate</label><strong>{pct(winRate)}</strong></div>
          <div className="chip-raised"><label>Trades</label><strong>{s.trades}</strong></div>
          <span className={`chip-status ${s.running ? "on" : ""}`}>{s.running ? "Running" : "Idle"}</span>
        </div>
        <div className="slab-inner">
          <div className="slab-inner-top">
            <span>Last trade</span>
            {last && <span className={`chip-tag ${last.won ? "up" : "down"}`}>{last.won ? "Won" : "Lost"}</span>}
          </div>
          <div className="slab-inner-body">
            <strong>{last ? last.label : "Waiting for an edge"}</strong>
            {last && <span>{usd(last.stake)} stake · {signedUsd(last.pnl)}</span>}
          </div>
          <Sparkline values={[0, ...s.equity.slice(-80)]} baseline={0} stroke="#4cc38a" height={46} grid={0} />
        </div>
      </div>
    </div>
  );
}
