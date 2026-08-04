import { useMemo, useSyncExternalStore, type CSSProperties } from "react";
import type { AppConfig } from "../lib/config";
import {
  AI_TRADE_NOTE,
  getAiBankroll,
  subscribeAiBankroll,
  type AiOperatorStatus,
} from "../lib/ai/bankroll";
import {
  getTrades,
  subscribeTrades,
  type StoredTrade,
} from "../lib/bot/tradeStore";
import type { AiOperatorApi } from "../hooks/useAiOperator";

interface AiPanelProps {
  operator: AiOperatorApi;
  currency: string;
  mode: AppConfig["mode"];
  botRunning: boolean;
}

const STATUS_LABEL: Record<AiOperatorStatus, string> = {
  idle: "Idle",
  scanning: "Scanning",
  hunting: "Hunting",
  paused: "Paused",
  stopped: "Stopped",
};

function bankSnapshot() {
  return getAiBankroll();
}

function clock(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function money(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

export function AiPanel({
  operator,
  currency,
  mode,
  botRunning,
}: AiPanelProps) {
  const store = useSyncExternalStore(subscribeAiBankroll, bankSnapshot, bankSnapshot);
  const trades = useSyncExternalStore(subscribeTrades, getTrades, getTrades);
  const { pocket, arm, disarm, restart, updateConfig, state } = operator;
  const armed = state.armed;
  const aimTarget = pocket.takeProfitAt ?? store.aimProfit;
  const aimPct = pocket.aimProgressPercent;
  const reservePct = Math.min(
    100,
    Math.max(0, (pocket.reserveFloor / Math.max(pocket.allocated, 1)) * 100),
  );
  const remainingPct = Math.min(
    100,
    Math.max(0, (pocket.remaining / Math.max(pocket.allocated, 1)) * 100),
  );

  const aiTrades = useMemo(() => {
    const tagged = trades.filter((trade) => trade.note === AI_TRADE_NOTE);
    const runStart = store.runStartedAt;
    const thisRun =
      runStart === null
        ? tagged
        : tagged.filter((trade) => trade.at >= runStart);
    return { all: tagged, thisRun };
  }, [trades, store.runStartedAt]);

  const aiStats = useMemo(() => {
    const list = aiTrades.thisRun;
    let wins = 0;
    let pnl = 0;
    for (const trade of list) {
      if (trade.won) wins += 1;
      pnl += trade.pnl;
    }
    const trades = list.length;
    const losses = trades - wins;
    const winRate = trades ? (wins / trades) * 100 : 0;
    /** Matches ~8.33× → break-even ≈ 12% wins. */
    const matchBreakEven = 12;
    const avg = trades ? pnl / trades : 0;
    return {
      trades,
      wins,
      losses,
      pnl,
      winRate,
      matchBreakEven,
      avg,
      aboveBreakEven: trades === 0 || winRate >= matchBreakEven,
    };
  }, [aiTrades.thisRun]);

  return (
    <div className="ai-shell" aria-label="AI Operator">
      <header className="ai-shell__bar">
        <div>
          <h2>AI Operator</h2>
          <p>
            Mission: turn{" "}
            <strong>
              {store.allocated.toFixed(0)} {currency}
            </strong>{" "}
            into{" "}
            <strong>
              +{aimTarget.toFixed(0)} {currency}
            </strong>{" "}
            · Restart gives a clean 50 {currency} demo pocket from 0.
          </p>
        </div>
        <span className={`ai-panel__status ai-panel__status--${state.status}`}>
          {STATUS_LABEL[state.status]}
          {botRunning && armed ? " · bot on" : ""}
        </span>
      </header>

      <div className="ai-shell__split">
        <aside className="ai-pane ai-pane--setup" aria-label="Setup bankroll">
          <div className="ai-pane__head">
            <em>1</em>
            <div>
              <h3>Setup</h3>
              <p>Pocket, aim, and how hard it presses when confident.</p>
            </div>
          </div>

          <p className="ai-panel__disclaimer">
            Operator trades <strong>Matches only</strong> at stake{" "}
            <strong>0.35</strong> when EV + timing line up. One win (~+2.78)
            covers about eight −0.35 losses — need ~12% wins to break even.
            Martingale stays off. Aim is not guaranteed.
          </p>

          <section className="ai-panel__section">
            <h4>Mission</h4>
            <div className="ai-panel__grid ai-panel__grid--stack">
              <label className="ai-field">
                <span>Start bankroll ({currency})</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={store.allocated}
                  disabled={armed}
                  onChange={(event) =>
                    updateConfig({ allocated: Number(event.target.value) || 1 })
                  }
                />
              </label>
              <label className="ai-field">
                <span>Aim profit ({currency})</span>
                <input
                  type="number"
                  min={0}
                  step={10}
                  value={store.aimProfit}
                  disabled={armed}
                  onChange={(event) =>
                    updateConfig({
                      aimProfit: Number(event.target.value) || 0,
                    })
                  }
                />
              </label>
            </div>
          </section>

          <section className="ai-panel__section">
            <h4>Risk &amp; confidence</h4>
            <div className="ai-panel__grid ai-panel__grid--stack">
              <label className="ai-field">
                <span>Reserve %</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  step={1}
                  value={store.reservePercent}
                  disabled={armed}
                  onChange={(event) =>
                    updateConfig({
                      reservePercent: Number(event.target.value) || 10,
                    })
                  }
                />
              </label>
              <label className="ai-field">
                <span>Base max stake</span>
                <input
                  type="number"
                  min={0.35}
                  step={0.05}
                  value={store.maxStakePerTrade}
                  disabled={armed}
                  onChange={(event) =>
                    updateConfig({
                      maxStakePerTrade: Number(event.target.value) || 0.35,
                    })
                  }
                />
              </label>
              <label className="ai-field">
                <span>Confident max stake</span>
                <input
                  type="number"
                  min={0.35}
                  step={0.05}
                  value={store.confidentMaxStake}
                  disabled={armed}
                  onChange={(event) =>
                    updateConfig({
                      confidentMaxStake: Number(event.target.value) || 0.35,
                    })
                  }
                />
              </label>
              <label className="ai-field">
                <span>Stop-loss % of pocket</span>
                <input
                  type="number"
                  min={0}
                  max={90}
                  value={store.stopLossPercent}
                  disabled={armed}
                  onChange={(event) =>
                    updateConfig({
                      stopLossPercent: Number(event.target.value) || 0,
                    })
                  }
                />
              </label>
              <label className="ai-field">
                <span>Scan every (min)</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={store.scanIntervalMinutes}
                  disabled={armed}
                  onChange={(event) =>
                    updateConfig({
                      scanIntervalMinutes: Number(event.target.value) || 5,
                    })
                  }
                />
              </label>
              <label className="ai-switch">
                <input
                  type="checkbox"
                  checked={false}
                  disabled
                  readOnly
                />
                <span>
                  Martingale locked off — Differs cannot recover doubled stakes
                </span>
              </label>
            </div>
          </section>

          <p className="ai-panel__mode">
            Mode follows app settings: <strong>{mode}</strong>
            {mode === "live" ? " · real buys on connected account" : " · paper / demo sizing"}
          </p>
        </aside>

        <aside className="ai-pane ai-pane--run" aria-label="Run operator">
          <div className="ai-pane__head">
            <em>2</em>
            <div>
              <h3>Run</h3>
              <p>Aim, pocket, every AI trade, policy events.</p>
            </div>
          </div>

          <section className="ai-panel__section">
            <h4>Aim progress</h4>
            <div className="ai-aim">
              <div className="ai-aim__row">
                <span>
                  {store.allocated.toFixed(0)} {currency}
                </span>
                <strong>
                  → +{aimTarget.toFixed(0)} {currency}
                </strong>
              </div>
              <div className="ai-aim__bar" aria-hidden="true">
                <i style={{ width: `${aimPct}%` }} />
              </div>
              <div className="ai-aim__meta">
                <span>
                  Now{" "}
                  <b className={pocket.aiPnl >= 0 ? "is-up" : "is-down"}>
                    {pocket.aiPnl >= 0 ? "+" : ""}
                    {pocket.aiPnl.toFixed(2)}
                  </b>
                </span>
                <span>{aimPct.toFixed(0)}% of aim</span>
              </div>
            </div>
          </section>

          <section className="ai-panel__section">
            <h4>Pocket health</h4>
            <div className="ai-panel__hero">
              <div>
                <span>Remaining</span>
                <strong>
                  {pocket.remaining.toFixed(2)}{" "}
                  <small>{currency}</small>
                </strong>
              </div>
              <div>
                <span>AI PnL</span>
                <strong className={pocket.aiPnl >= 0 ? "is-up" : "is-down"}>
                  {pocket.aiPnl >= 0 ? "+" : ""}
                  {pocket.aiPnl.toFixed(2)}{" "}
                  <small>{currency}</small>
                </strong>
              </div>
            </div>

            <div
              className="ai-panel__bar ai-panel__bar--split"
              aria-hidden="true"
              style={
                {
                  "--reserve-pct": `${reservePct}%`,
                } as CSSProperties
              }
            >
              <i style={{ width: `${remainingPct}%` }} />
              <b title="Reserve floor" />
            </div>
            <div className="ai-panel__bar-legend">
              <span>Usable {pocket.usable.toFixed(2)}</span>
              <span>Reserve {pocket.reserveFloor.toFixed(2)}</span>
            </div>

            <div className="ai-panel__meters">
              <div>
                <span>Win rate</span>
                <strong className={aiStats.aboveBreakEven ? "is-up" : "is-down"}>
                  {aiStats.winRate.toFixed(0)}%
                </strong>
              </div>
              <div>
                <span>Matches BE</span>
                <strong>~{aiStats.matchBreakEven}%</strong>
              </div>
              <div>
                <span>W / L</span>
                <strong>
                  {aiStats.wins} / {aiStats.losses}
                </strong>
              </div>
              <div>
                <span>Avg / trade</span>
                <strong className={aiStats.avg >= 0 ? "is-up" : "is-down"}>
                  {aiStats.avg >= 0 ? "+" : ""}
                  {aiStats.avg.toFixed(2)}
                </strong>
              </div>
            </div>

            <p className="ai-panel__math-hint">
              Matches: one +2.78 win covers about eight −0.35 losses. Judge by{" "}
              <strong>AI PnL</strong>, not the LOSS count. Need ~12% wins to
              break even —{" "}
              {aiStats.trades === 0
                ? "no trades yet."
                : aiStats.aboveBreakEven
                  ? `you are at ${aiStats.winRate.toFixed(0)}% (above BE).`
                  : `you are at ${aiStats.winRate.toFixed(0)}% (below BE).`}
            </p>

            {state.lastStopReason ? (
              <p className="ai-panel__stop-reason">{state.lastStopReason}</p>
            ) : null}
          </section>

          <div className="ai-panel__actions ai-panel__actions--triple">
            {armed ? (
              <button
                type="button"
                className="ai-panel__stop"
                onClick={() => disarm("Admin stop")}
              >
                Stop Operator
              </button>
            ) : (
              <button type="button" className="ai-panel__start" onClick={arm}>
                Start · chase +{aimTarget.toFixed(0)}
              </button>
            )}
            <button
              type="button"
              className="ai-panel__restart"
              onClick={() => restart(50)}
            >
              Restart · 50 {currency}
            </button>
          </div>

          <section className="ai-panel__section ai-panel__section--trades">
            <h4>
              AI trades
              <em>
                this run {aiTrades.thisRun.length}
                {aiTrades.all.length !== aiTrades.thisRun.length
                  ? ` · all ${aiTrades.all.length}`
                  : ""}
              </em>
            </h4>
            {aiTrades.thisRun.length === 0 ? (
              <p className="ai-trades__empty">
                No AI trades this run yet. Restart for a clean 50 {currency}{" "}
                pocket, then Start.
              </p>
            ) : (
              <div className="ai-trades" role="table" aria-label="AI Operator trades">
                <div className="ai-trades__row ai-trades__row--head" role="row">
                  <span>Time</span>
                  <span>Side</span>
                  <span>Stake</span>
                  <span>Result</span>
                  <span>PnL</span>
                </div>
                {aiTrades.thisRun.map((trade) => (
                  <TradeRow key={`${trade.id}-${trade.at}`} trade={trade} />
                ))}
              </div>
            )}
          </section>

          <section className="ai-panel__section ai-panel__section--log">
            <h4>Policy log</h4>
            <ul className="ai-panel__log">
              {store.log.length === 0 ? (
                <li>No events yet. Restart or Start to begin.</li>
              ) : (
                store.log.map((line, i) => (
                  <li key={`${i}-${line}`}>{line}</li>
                ))
              )}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function TradeRow({ trade }: { trade: StoredTrade }) {
  return (
    <div className="ai-trades__row" role="row">
      <span>{clock(trade.at)}</span>
      <span>
        {/* side labels: Matches / Differs / Over / Under */}
        {`${
          trade.side === "DIGITMATCH"
            ? "Matches"
            : trade.side === "DIGITDIFF"
              ? "Differs"
              : trade.side === "DIGITOVER"
                ? "Over"
                : "Under"
        } ${trade.digit}`}
      </span>
      <span>
        {trade.contracts > 1 ? `${trade.contracts}×` : ""}
        {trade.stake.toFixed(2)}
      </span>
      <span className={trade.won ? "is-up" : "is-down"}>
        {trade.won ? "WIN" : "LOSS"}
      </span>
      <span className={trade.pnl >= 0 ? "is-up" : "is-down"}>
        {money(trade.pnl)}
      </span>
    </div>
  );
}
