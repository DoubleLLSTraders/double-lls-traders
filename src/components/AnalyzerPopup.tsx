import { useMemo } from "react";
import type { DigitStats } from "../lib/analysis/digits";
import { buildAiBrief } from "../lib/analysis/explain";
import {
  confirmScore,
  isFullyConfirmed,
  type MarketSignal,
} from "../lib/analysis/signal";
import { evaluateEntry } from "../lib/bot/gates";
import type { Tick } from "../lib/deriv/types";
import type { BotSettings } from "./BotPanel";
import { ModeChooser } from "./ModeChooser";

interface AnalyzerPopupProps {
  stats: DigitStats;
  signal: MarketSignal;
  matchSignal: MarketSignal;
  diffSignal: MarketSignal;
  bot: BotSettings;
  latest: Tick | undefined;
  symbol: string;
  disabled?: boolean;
  onApply: (next: Partial<BotSettings>) => void;
  onSelectSide: (side: BotSettings["side"]) => void;
  onOpenMarket: () => void;
}

export function AnalyzerPopup({
  stats,
  signal,
  matchSignal,
  diffSignal,
  bot,
  latest,
  symbol,
  disabled = false,
  onApply,
  onSelectSide,
  onOpenMarket,
}: AnalyzerPopupProps) {
  const focusPct = stats.percentages[bot.prediction] ?? 0;
  const focusGap = stats.gaps[bot.prediction];
  const score = confirmScore(signal);
  const matchScore = confirmScore(matchSignal);
  const diffScore = confirmScore(diffSignal);

  const gate = useMemo(
    () => evaluateEntry(bot, signal, { symbol }),
    [bot, signal, symbol],
  );
  const brief = useMemo(
    () =>
      buildAiBrief({
        signal,
        stats,
        gate,
        botDigit: bot.prediction,
        minEdgePercent: bot.minEdgePercent,
      }),
    [signal, stats, gate, bot.prediction, bot.minEdgePercent],
  );

  // Manual by default — do not force auto on mount.

  return (
    <aside className="analyzer-panel" aria-label="Live market analyzer">
      <div className="analyzer-panel__head">
        <div>
          <h3>Analyzer</h3>
          <p>
            {!bot.autoSide
              ? bot.side === "DIGITDIFF"
                ? "Differs · you chose the side · bot picks the cold barrier."
                : "Matches · you chose the side · bot picks the hot digit."
              : bot.sidePreference === "differs"
                ? "Auto · Differs when the analyzer arms it."
                : bot.sidePreference === "matches"
                  ? "Auto · Matches when the analyzer arms it."
                  : bot.sidePreference === "winrate"
                    ? "Auto · Differs first, Matches as fallback."
                    : "Auto · whichever side has the stronger edge."}
          </p>
        </div>
        <button type="button" className="analyzer-panel__link" onClick={onOpenMarket}>
          Market
        </button>
      </div>

      <ModeChooser
        value={bot.side}
        auto={bot.autoSide}
        disabled={disabled}
        onChange={onSelectSide}
        onEnableAuto={() => onApply({ autoSide: true })}
      />

      <div className="analyzer-live">
        <div>
          <span>Price</span>
          <strong>{latest ? latest.quote.toFixed(latest.pipSize) : "—"}</strong>
          <small>{symbol}</small>
        </div>
        <div>
          <span>Last digit</span>
          <strong className="is-digit">{latest ? latest.digit : "—"}</strong>
          <small>every tick</small>
        </div>
      </div>

      <div className="analyzer-board">
        <div>
          <span>Confirms</span>
          <strong className={isFullyConfirmed(signal) ? "is-up" : ""}>
            {score}/5
          </strong>
        </div>
        <div>
          <span>M / D score</span>
          <strong>
            {matchScore} · {diffScore}
          </strong>
        </div>
        <div>
          <span>Hot</span>
          <strong>{signal.watching.hot}</strong>
        </div>
        <div>
          <span>Cold</span>
          <strong>{signal.watching.cold}</strong>
        </div>
        <div>
          <span>Edge</span>
          <strong className={signal.windowFair ? "is-down" : "is-up"}>
            {signal.windowFair ? "Random" : "Uneven"}
          </strong>
        </div>
        <div>
          <span>Windows</span>
          <strong className={signal.windowsAgree ? "is-up" : ""}>
            {signal.windowsAgree ? "Agree" : "Split"}
          </strong>
        </div>
        <div>
          <span>EV gate</span>
          <strong className={signal.evOk ? "is-up" : "is-down"}>
            {signal.evOk ? "Open" : "Closed"}
          </strong>
        </div>
        <div>
          <span>Multi-EV</span>
          <strong className={signal.windowsEvOk ? "is-up" : "is-down"}>
            {signal.windowsEvOk ? "Ok" : "No"}
          </strong>
        </div>
        <div>
          <span>Timing</span>
          <strong className={signal.timingOk ? "is-up" : "is-down"}>
            {signal.timingOk ? "Ok" : "No"}
          </strong>
        </div>
        <div>
          <span>χ² + lead</span>
          <strong className={signal.structureOk ? "is-up" : "is-down"}>
            {signal.structureOk ? "Ok" : "No"}
          </strong>
        </div>
        <div>
          <span>Separation</span>
          <strong className={signal.separationOk ? "is-up" : ""}>
            {signal.watching.separation || "—"}
          </strong>
        </div>
        <div>
          <span>Wilson EV</span>
          <strong className={signal.evOk ? "is-up" : "is-down"}>
            {signal.watching.wilsonBound || "—"}
          </strong>
        </div>
        <div>
          <span>Votes</span>
          <strong className="analyzer-board__votes">{signal.watching.windowVotes || "—"}</strong>
        </div>
        <div>
          <span>Signal %</span>
          <strong>{signal.digitPercent.toFixed(1)}%</strong>
        </div>
        <div>
          <span>Streak</span>
          <strong>{signal.watching.streak}</strong>
        </div>
      </div>

      <div className="analyzer-check">
        <span>Bot digit {bot.prediction}</span>
        <strong>{focusPct.toFixed(1)}%</strong>
        <p>
          {focusPct - 10 >= 0 ? "+" : ""}
          {(focusPct - 10).toFixed(1)} vs 10% ·{" "}
          {focusGap === null ? "absent" : `${focusGap} ticks ago`}
        </p>
      </div>

      <div className={`analyzer-signal analyzer-signal--${signal.confidence}`}>
        <div className="analyzer-signal__top">
          <em>
            {score}/5 · {signal.confidence}
          </em>
        </div>
        <strong className="analyzer-signal__title">{signal.label}</strong>
        <p className="analyzer-signal__reason">{signal.reason}</p>
        <button
          type="button"
          className="analyzer-signal__cta"
          onClick={() =>
            onApply({
              prediction: signal.digit,
              autoFollow: true,
            })
          }
        >
          Feed digit to bot
        </button>
      </div>

      <div className="ai-brief" aria-label="AI explanation">
        <div className="ai-brief__head">
          <h4>AI explain</h4>
          <em className={gate.ok ? "is-up" : "is-down"}>{gate.ok ? "Pass" : "Hold"}</em>
        </div>
        <p className="ai-brief__headline">{brief.headline}</p>
        <ul>
          {brief.bullets.map((line) => (
            <li key={line.slice(0, 48)}>{line}</li>
          ))}
        </ul>
        <p className="ai-brief__decision">{brief.decision}</p>
        <p className="ai-brief__caution">{brief.caution}</p>
      </div>
    </aside>
  );
}
