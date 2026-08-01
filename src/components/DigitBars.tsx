import { useEffect, useMemo, useRef, useState } from "react";
import { DIGITS } from "../lib/analysis/digits";
import type { DigitStats } from "../lib/analysis/digits";
import {
  readMarketPulse,
  type PulseRequirements,
} from "../lib/analysis/marketPulse";
import type { AnalyzerDirective } from "../lib/analysis/analyzerDirector";
import type { MarketSignal } from "../lib/analysis/signal";
import { playGoodSetupSound } from "../lib/sound";
import { SoundControlButton } from "./SoundControlButton";

type Tone = "high" | "second" | "low" | "neutral";

interface DigitBarsProps {
  stats: DigitStats;
  selectedDigit: number | null;
  onSelectDigit: (digit: number) => void;
  /** Most recent live digit — pulses on the matching tile. */
  latestDigit?: number | null;
  /** Live analyzer signal — sharpens the market mood readout. */
  signal?: MarketSignal | null;
  /** Steady-lock director — Digits Good only when desk may follow. */
  director?: AnalyzerDirective | null;
  /** Market symbol — resets alerts when volatility hops. */
  symbol?: string;
  /** Bot gate floors shown as “Good needs …”. */
  requirements?: PulseRequirements;
}

function toneByRank(counts: number[], sampleSize: number): Tone[] {
  const tones = new Array<Tone>(10).fill("neutral");
  if (sampleSize === 0) return tones;

  const ranked = [...DIGITS].sort((a, b) =>
    counts[b] !== counts[a] ? counts[b] - counts[a] : a - b,
  );
  tones[ranked[0]] = "high";
  tones[ranked[1]] = "second";
  tones[ranked[ranked.length - 1]] = "low";
  return tones;
}

function rankLabel(rank: number): string {
  if (rank === 1) return "hottest";
  if (rank === 2) return "2nd hottest";
  if (rank === 10) return "coldest";
  if (rank === 9) return "2nd coldest";
  return `#${rank} of 10`;
}

const RING = 2 * Math.PI * 22; // r=22 in 52 viewBox

export function DigitBars({
  stats,
  selectedDigit,
  onSelectDigit,
  latestDigit = null,
  signal = null,
  director = null,
  symbol = "",
  requirements,
}: DigitBarsProps) {
  const { counts, percentages, sampleSize, gaps, hottest, coldest } = stats;
  const tones = toneByRank(counts, sampleSize);
  const maxPct = Math.max(...percentages, 10);
  const [pulseDigit, setPulseDigit] = useState<number | null>(null);
  const [hoverDigit, setHoverDigit] = useState<number | null>(null);
  const basePulse = useMemo(
    () => readMarketPulse(stats, signal, requirements),
    [stats, signal, requirements],
  );
  const pulse = useMemo(() => {
    if (!director) return basePulse;
    if (director.buyNow) {
      const sideLabel =
        director.side === "DIGITMATCH" ? "Matches" : "Differs";
      const vol = requirements?.volatilityLabel ?? "";
      const gap = signal?.watching.signalGap ?? "—";
      const minGap = requirements?.minColdGap ?? 6;
      const pct =
        signal?.digitPercent !== undefined
          ? signal.digitPercent.toFixed(1)
          : "—";
      const power = signal?.power ?? "—";
      const entry = `ENTRY ${sideLabel} ${director.digit}${
        vol ? ` · ${vol}` : ""
      } · gap ${gap}/${minGap} · cold ${pct}% · power ${power}`;
      return {
        ...basePulse,
        mood: "good" as const,
        label: "Trade now",
        detail: entry,
      };
    }
    if (
      director.label === "Locking" ||
      director.label === "Confirming" ||
      director.label === "Almost"
    ) {
      return {
        ...basePulse,
        mood: "watch" as const,
        label: director.label,
        detail: director.detail,
      };
    }
    return {
      ...basePulse,
      label: director.label === "Watch" ? basePulse.label : director.label,
      detail: director.detail || basePulse.detail,
    };
  }, [basePulse, director, requirements, signal]);
  const alertKeyRef = useRef("");
  const symbolAlertRef = useRef(symbol);
  const huntStartRef = useRef(Date.now());
  const wasTradeNowRef = useRef(false);
  const [waitMs, setWaitMs] = useState(0);
  const [lastConfirmLabel, setLastConfirmLabel] = useState<string | null>(null);

  // Confirm / hunt timer on Digits.
  useEffect(() => {
    huntStartRef.current = Date.now();
    wasTradeNowRef.current = false;
    setWaitMs(0);
    setLastConfirmLabel(null);
  }, [symbol]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const tradeNow =
        pulse.label === "Trade now" || director?.buyNow === true;
      if (tradeNow) {
        if (!wasTradeNowRef.current) {
          const ms = Date.now() - huntStartRef.current;
          const totalSec = Math.max(0, Math.round(ms / 1000));
          const m = Math.floor(totalSec / 60);
          const s = totalSec % 60;
          setLastConfirmLabel(
            `✓ ${m}:${s.toString().padStart(2, "0")}`,
          );
          wasTradeNowRef.current = true;
        }
        return;
      }
      if (wasTradeNowRef.current) {
        // New hunt after Trade now clears.
        wasTradeNowRef.current = false;
        huntStartRef.current = Date.now();
      }
      const lockSince = director?.hold?.lockSinceMs;
      if (
        lockSince &&
        (director?.label === "Locking" || director?.label === "Confirming")
      ) {
        setWaitMs(Date.now() - huntStartRef.current);
        return;
      }
      setWaitMs(Date.now() - huntStartRef.current);
    }, 250);
    return () => window.clearInterval(id);
  }, [pulse.label, director?.buyNow, director?.label, director?.hold?.lockSinceMs]);

  const timerText = useMemo(() => {
    const totalSec = Math.max(0, Math.floor(waitMs / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const clock = `${m}:${s.toString().padStart(2, "0")}`;
    if (pulse.label === "Trade now" || director?.buyNow) {
      return lastConfirmLabel ?? `✓ ${clock}`;
    }
    if (director?.label === "Locking") return `Lock ${clock}`;
    if (director?.label === "Confirming") return `Confirm ${clock}`;
    return `Wait ${clock}`;
  }, [
    waitMs,
    lastConfirmLabel,
    pulse.label,
    director?.buyNow,
    director?.label,
  ]);

  // Sound only when Digits shows Trade now (desk may buy).
  useEffect(() => {
    if (symbolAlertRef.current !== symbol) {
      symbolAlertRef.current = symbol;
      alertKeyRef.current = "";
    }
    const tradeNow =
      pulse.label === "Trade now" ||
      (director?.buyNow === true && pulse.mood === "good");
    if (!tradeNow) {
      if (
        pulse.label !== "Locking" &&
        pulse.label !== "Confirming" &&
        pulse.mood !== "good"
      ) {
        alertKeyRef.current = "";
      }
      return;
    }
    const digit = director?.digit ?? signal?.digit ?? "";
    const key = `${symbol}|trade-now|${digit}`;
    if (alertKeyRef.current === key) return;
    alertKeyRef.current = key;
    playGoodSetupSound();
  }, [
    pulse.mood,
    pulse.label,
    director?.buyNow,
    director?.digit,
    signal?.digit,
    symbol,
  ]);

  useEffect(() => {
    if (latestDigit === null || latestDigit === undefined) return;
    setPulseDigit(latestDigit);
    const timer = window.setTimeout(() => setPulseDigit(null), 700);
    return () => window.clearTimeout(timer);
  }, [latestDigit, sampleSize]);

  const ranked = [...DIGITS].sort((a, b) =>
    counts[b] !== counts[a] ? counts[b] - counts[a] : a - b,
  );
  const rankOf = (digit: number) => (ranked as readonly number[]).indexOf(digit) + 1;

  return (
    <section className="panel digit-map">
      <div className="panel__head">
        <h2>Digits</h2>
        <span className="digit-map__live">
          <i className={sampleSize > 0 ? "is-on" : ""} aria-hidden="true" />
          {sampleSize.toLocaleString()} ticks
        </span>
      </div>

      <div className="digit-grid" role="list">
        {DIGITS.map((digit) => {
          const pct = percentages[digit] ?? 0;
          const count = counts[digit] ?? 0;
          const gap = gaps[digit];
          const vsFair = pct - 10;
          const fill = Math.min(1, pct / Math.max(maxPct, 0.001));
          const dash = `${(fill * RING).toFixed(2)} ${RING.toFixed(2)}`;
          const entryDigit =
            director?.buyNow === true ? director.digit : null;
          const selected = selectedDigit === digit || entryDigit === digit;
          const live = latestDigit === digit;
          const pulsing = pulseDigit === digit;
          const hovering = hoverDigit === digit;
          const tone = tones[digit];
          const rank = rankOf(digit);

          return (
            <button
              type="button"
              key={digit}
              role="listitem"
              className={[
                "digit-tile",
                selected ? "digit-tile--selected" : "",
                entryDigit === digit ? "digit-tile--entry" : "",
                live ? "digit-tile--live" : "",
                pulsing ? "digit-tile--pulse" : "",
                hovering ? "digit-tile--hover" : "",
                `digit-tile--${tone}`,
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelectDigit(digit)}
              onPointerEnter={() => setHoverDigit(digit)}
              onPointerLeave={() => setHoverDigit((d) => (d === digit ? null : d))}
              aria-pressed={selected}
              aria-label={`Digit ${digit}, ${pct.toFixed(1)} percent, ${count} of ${sampleSize}`}
            >
              <span className="digit-tile__ring-wrap">
                <svg className="digit-tile__ring" viewBox="0 0 52 52" aria-hidden="true">
                  <circle className="digit-tile__ring-track" cx="26" cy="26" r="22" />
                  <circle
                    className={`digit-tile__ring-fill digit-tile__ring-fill--${tone}`}
                    cx="26"
                    cy="26"
                    r="22"
                    strokeDasharray={dash}
                    transform="rotate(-90 26 26)"
                  />
                </svg>
                <span className="digit-tile__box">{digit}</span>
              </span>

              <span className={`digit-tile__percent digit-tile__percent--${tone}`}>
                {pct.toFixed(1)}%
              </span>

              {hovering ? (
                <span className="digit-tile__tip" role="tooltip">
                  <strong>Digit {digit}</strong>
                  <em>
                    {count.toLocaleString()} / {sampleSize.toLocaleString()} ·{" "}
                    {pct.toFixed(2)}%
                  </em>
                  <em>
                    {vsFair >= 0 ? "+" : ""}
                    {vsFair.toFixed(1)} vs 10% · {rankLabel(rank)}
                  </em>
                  <em>
                    Gap {gap === null ? "absent" : `${gap} tick${gap === 1 ? "" : "s"}`}
                    {hottest[0] === digit
                      ? " · hot"
                      : coldest[0] === digit
                        ? " · cold"
                        : ""}
                  </em>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        className={`digit-map__pulse digit-map__pulse--${pulse.mood}`}
        title={`${pulse.detail} · ${pulse.need}`}
      >
        <div className="digit-map__pulse-main">
          <span className="digit-map__pulse-dot" aria-hidden="true" />
          <strong>{pulse.label}</strong>
          <SoundControlButton className="digit-map__alert-btn" />
          <em>{pulse.detail}</em>
          <span className="digit-map__timer" title="Time waiting / to confirm">
            {timerText}
          </span>
          {lastConfirmLabel &&
          pulse.label !== "Trade now" &&
          !director?.buyNow ? (
            <span className="digit-map__timer-last" title="Last confirm time">
              Last {lastConfirmLabel}
            </span>
          ) : null}
        </div>
        <div className="digit-map__legend">
          <span className="is-high">Hot</span>
          <span className="is-low">Cold</span>
          <span>Fair 10%</span>
          <span className="digit-map__legend-need">{pulse.need}</span>
          {latestDigit !== null && latestDigit !== undefined ? (
            <span className="digit-map__legend-live">Live · {latestDigit}</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
