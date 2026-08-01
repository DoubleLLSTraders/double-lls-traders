import { useMemo, useState, useSyncExternalStore } from "react";
import type { BotSession } from "../lib/bot/types";
import type { PerformanceStats } from "../lib/bot/performance";
import { downloadTradesPdf } from "../lib/bot/exportTradesPdf";
import {
  clearTrades,
  getTrades,
  subscribeTrades,
  type StoredTrade,
} from "../lib/bot/tradeStore";

interface TradesPanelProps {
  session: BotSession;
  performance: PerformanceStats;
  currency: string;
  symbol: string;
}

function clock(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function day(epoch: number): string {
  return new Date(epoch * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function money(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

export function TradesPanel({
  session,
  performance,
  currency,
  symbol,
}: TradesPanelProps) {
  const trades = useSyncExternalStore(subscribeTrades, getTrades, getTrades);
  const [exporting, setExporting] = useState(false);

  const totals = useMemo(() => {
    let wins = 0;
    let pnl = 0;
    for (const trade of trades) {
      if (trade.won) wins += 1;
      pnl += trade.pnl;
    }
    return {
      trades: trades.length,
      wins,
      losses: trades.length - wins,
      pnl,
      winRate: trades.length ? (wins / trades.length) * 100 : 0,
      expectancy: trades.length ? pnl / trades.length : 0,
    };
  }, [trades]);

  /** Anchored to the all-time net and walked backwards so the newest row
      always reads as the current balance change. */
  const rows = useMemo(() => {
    let running = totals.pnl;
    return trades.map((trade) => {
      const row = { trade, running };
      running -= trade.pnl;
      return row;
    });
  }, [trades, totals.pnl]);

  const open = session.open;

  return (
    <section className="trades">
      <header className="trades__head">
        <div>
          <h2>Trades</h2>
          <p>
            Every settled basket, saved on this device · newest first
          </p>
        </div>
        <div className="trades__head-right">
          <div className="trades__net">
            <span>All time</span>
            <strong className={totals.pnl >= 0 ? "is-up" : "is-down"}>
              {money(totals.pnl)} {currency}
            </strong>
          </div>
          <button
            type="button"
            className="trades__pdf"
            disabled={exporting || trades.length === 0}
            onClick={() => {
              setExporting(true);
              void downloadTradesPdf(trades, {
                trades: totals.trades,
                wins: totals.wins,
                losses: totals.losses,
                pnl: totals.pnl,
                winRate: totals.winRate,
                expectancy: totals.expectancy,
                sessionPnl: session.pnl,
                breakEvenWinRate: performance.breakEvenWinRate,
                currency,
              })
                .catch((err: unknown) => {
                  const message =
                    err instanceof Error ? err.message : String(err);
                  window.alert(`PDF export failed · ${message}`);
                })
                .finally(() => setExporting(false));
            }}
          >
            {exporting ? "Preparing PDF…" : "Download PDF"}
          </button>
          {trades.length > 0 ? (
            <button
              type="button"
              className="trades__clear"
              onClick={() => {
                if (confirm(`Delete all ${trades.length} saved trades?`)) {
                  clearTrades();
                }
              }}
            >
              Clear history
            </button>
          ) : null}
        </div>
      </header>

      <div className="trades__summary">
        <div className="trades__stat">
          <span>Trades</span>
          <strong>{totals.trades}</strong>
        </div>
        <div className="trades__stat">
          <span>Won</span>
          <strong className="is-up">{totals.wins}</strong>
        </div>
        <div className="trades__stat">
          <span>Lost</span>
          <strong className="is-down">{totals.losses}</strong>
        </div>
        <div className="trades__stat">
          <span>Win rate</span>
          <strong>{totals.winRate.toFixed(1)}%</strong>
        </div>
        <div className="trades__stat">
          <span>Break-even needs</span>
          <strong>{performance.breakEvenWinRate.toFixed(1)}%</strong>
        </div>
        <div className="trades__stat">
          <span>Per trade</span>
          <strong className={totals.expectancy >= 0 ? "is-up" : "is-down"}>
            {money(totals.expectancy)}
          </strong>
        </div>
        <div className="trades__stat">
          <span>This session</span>
          <strong className={session.pnl >= 0 ? "is-up" : "is-down"}>
            {money(session.pnl)}
          </strong>
        </div>
      </div>

      {open ? (
        <div className="trades__open">
          <span className="trades__badge trades__badge--open">Open</span>
          <b>
            {open.side === "DIGITMATCH" ? "Matches" : "Differs"} {open.digit}
          </b>
          <span>
            {open.contracts} × {open.stake.toFixed(2)} {currency}
          </span>
          <span>risk {(open.stake * open.contracts).toFixed(2)}</span>
          {open.payout !== undefined ? (
            <span className="is-up">
              win {money(open.payout - open.stake * open.contracts)}
            </span>
          ) : null}
          <em>settling…</em>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="trades__empty">
          No trades saved yet. Start the bot from the Bot tab and every settled
          basket on {symbol} will be recorded here.
        </p>
      ) : (
        <div className="trades__table" role="table" aria-label="Saved trades">
          <div className="trades__row trades__row--head" role="row">
            <span role="columnheader">Time</span>
            <span role="columnheader">Market</span>
            <span role="columnheader">Contract</span>
            <span role="columnheader">Size</span>
            <span role="columnheader">Settled</span>
            <span role="columnheader">Result</span>
            <span role="columnheader">P/L</span>
            <span role="columnheader">Running</span>
          </div>
          {rows.map(({ trade, running }) => (
            <TradeRow
              key={`${trade.id}-${trade.at}`}
              trade={trade}
              running={running}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TradeRow({ trade, running }: { trade: StoredTrade; running: number }) {
  return (
    <div role="row" className={`trades__row ${trade.won ? "is-win" : "is-loss"}`}>
      <span role="cell">
        {clock(trade.at)}
        <em className="trades__day">{day(trade.at)}</em>
      </span>
      <span role="cell">{trade.symbol ?? "—"}</span>
      <span role="cell">
        <b>
          {trade.side === "DIGITMATCH" ? "Matches" : "Differs"} {trade.digit}
        </b>
        {trade.mode === "paper" ? <em className="trades__id">paper</em> : null}
      </span>
      <span role="cell">
        {trade.contracts} × {trade.stake.toFixed(2)}
      </span>
      <span role="cell">
        {trade.settleDigit === null ? "—" : `digit ${trade.settleDigit}`}
      </span>
      <span role="cell">
        <span
          className={`trades__badge ${
            trade.won ? "trades__badge--win" : "trades__badge--loss"
          }`}
        >
          {trade.won ? "Profit" : "Loss"}
        </span>
      </span>
      <span role="cell" className={trade.won ? "is-up" : "is-down"}>
        {money(trade.pnl)}
      </span>
      <span role="cell" className={running >= 0 ? "is-up" : "is-down"}>
        {money(running)}
      </span>
    </div>
  );
}
