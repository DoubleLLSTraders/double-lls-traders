import { useEffect, useMemo, useRef, useState } from "react";
import { DIGITS } from "../lib/analysis/digits";
import type { DigitStats } from "../lib/analysis/digits";
import {
  readMarketPulse,
  type PulseRequirements,
} from "../lib/analysis/marketPulse";
import {
  resolveAnalyzerPace,
  type AnalyzerPaceId,
} from "../lib/analysis/analyzerPace";
import type { AnalyzerDirective } from "../lib/analysis/analyzerDirector";
import { isOverUnderSide, sideLabel } from "../lib/analysis/contractSide";
import {
  fairWinProb,
  scoreAllBarriers,
  type OuEntryMode,
  type OverUnderSide,
} from "../lib/analysis/overUnder";
import type { MarketSignal } from "../lib/analysis/signal";
import type { MarketSweep } from "../lib/analysis/marketSweep";
import { overUnderPayoutMultiplier } from "../lib/bot/performance";
import { playGoodSetupSound } from "../lib/sound";
import { SoundControlButton } from "./SoundControlButton";

/** Payout for using this digit as the Over/Under barrier. */
function ouBarrierPay(
  side: OverUnderSide,
  barrier: number,
  stake: number,
  contracts: number,
): { payout: number; win: number; fairPct: number; tradable: boolean } | null {
  if (side === "DIGITOVER" && (barrier < 0 || barrier > 8)) return null;
  if (side === "DIGITUNDER" && (barrier < 1 || barrier > 9)) return null;
  const payout = overUnderPayoutMultiplier(side, barrier);
  const exposure = Math.max(0.35, stake) * Math.max(1, contracts);
  const win = Number((exposure * (payout - 1)).toFixed(2));
  const fairPct = fairWinProb(side, barrier) * 100;
  const tradable =
    side === "DIGITOVER"
      ? barrier >= 0 && barrier <= 3
      : barrier >= 6 && barrier <= 9;
  return { payout, win, fairPct, tradable };
}

/** "1HZ75V" → "V75(1s)", "R_25" → "V25". */
function volShort(symbol: string): string {
  const hz = symbol.match(/^1HZ(\d+)V$/);
  if (hz) return `V${hz[1]}(1s)`;
  const r = symbol.match(/^R_(\d+)$/);
  if (r) return `V${r[1]}`;
  return symbol;
}

function sweepAge(scannedAt: number): string {
  const sec = Math.max(0, Math.round((Date.now() - scannedAt) / 1000));
  return sec < 60 ? `${sec}s ago` : `${Math.floor(sec / 60)}m ago`;
}

type Tone = "high" | "second" | "low" | "neutral";

interface DigitBarsProps {
  stats: DigitStats;
  /** Live tick digits — used for Over/Under Blitz readout. */
  digits?: readonly number[];
  selectedDigit: number | null;
  onSelectDigit: (digit: number) => void;
  latestDigit?: number | null;
  signal?: MarketSignal | null;
  director?: AnalyzerDirective | null;
  symbol?: string;
  requirements?: PulseRequirements;
  onAnalyzerPaceChange?: (pace: AnalyzerPaceId) => void;
  deskBusy?: "buying" | "open" | null;
  deskBusyDigit?: number | null;
  deskBusySide?: MarketSignal["side"] | null;
  /** Bot executor wait line — keeps Trade now in sync with Cooling / Skip. */
  executorWait?: string | null;
  /** Bot form barrier (prediction) — shown when it matches the live analyzer. */
  botBarrier?: number | null;
  botTakeProfit?: number | null;
  /** Stake / contracts for per-barrier pay-rate (+win) on the digit grid. */
  stake?: number;
  contracts?: number;
  /** Deep all-market sweep verdict (Over/Under desk). */
  sweep?: MarketSweep | null;
  sweepScanning?: boolean;
  /** OU entry mode — one run per Start, rolling momentum, or proven only. */
  entryMode?: OuEntryMode;
  onEntryModeChange?: (mode: OuEntryMode) => void;
}

const ENTRY_MODE_LABEL: Record<OuEntryMode, string> = {
  oneRun: "One run",
  momentum: "Shield",
  proven: "Proven only",
};

/** Click order: One run → Shield → Proven only → One run. */
const NEXT_ENTRY_MODE: Record<OuEntryMode, OuEntryMode> = {
  oneRun: "momentum",
  momentum: "proven",
  proven: "oneRun",
};

const ENTRY_MODE_HELP: Record<OuEntryMode, string> = {
  oneRun:
    "One run: only Over 0 vs Under 9 — picks whichever of those two is hotter right now, buys once, stops. Click for Shield.",
  momentum:
    "Shield: elite Over 1–2 / Under 7–8 only · commit up to 7 fast runs on that top tape · hop if it breaks. Click for Proven only.",
  proven:
    "Proven only: trades nothing until a barrier's corrected lower bound beats its payout break-even. May not trade for hours. Click for One run.",
};

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

const RING = 2 * Math.PI * 22;

export function DigitBars({
  stats,
  digits = [],
  selectedDigit,
  onSelectDigit,
  latestDigit = null,
  signal = null,
  director = null,
  symbol = "",
  requirements,
  onAnalyzerPaceChange,
  deskBusy = null,
  deskBusyDigit = null,
  deskBusySide = null,
  executorWait = null,
  botBarrier = null,
  botTakeProfit = null,
  stake = 0.35,
  contracts = 1,
  sweep = null,
  sweepScanning = false,
  entryMode = "oneRun",
  onEntryModeChange,
}: DigitBarsProps) {
  const pace = resolveAnalyzerPace(requirements?.analyzerPace);
  const differsPaceSwitch = pace.id === "steady" || pace.id === "safer-fast";
  const otherPace = resolveAnalyzerPace(
    pace.id === "steady" ? "safer-fast" : "steady",
  );
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
    if (deskBusy) {
      const side = deskBusySide ?? director?.side ?? signal?.side ?? "DIGITDIFF";
      const digit = deskBusyDigit ?? director?.digit ?? signal?.digit ?? 0;
      const label = sideLabel(side);
      return {
        ...basePulse,
        mood: "good" as const,
        label: deskBusy === "buying" ? "Buying" : "In trade",
        detail:
          deskBusy === "buying"
            ? `Executor sync · buying ${label} ${digit} now`
            : `Executor synced · ${label} ${digit} · in trade`,
      };
    }
    // Executor Cooling / Skip wins over analyzer Trade now — one synced status.
    if (
      executorWait &&
      (/^Cooling/i.test(executorWait) ||
        /^Skip/i.test(executorWait) ||
        /^Stopped/i.test(executorWait))
    ) {
      return {
        ...basePulse,
        mood: /^Cooling/i.test(executorWait)
          ? ("bounce" as const)
          : ("watch" as const),
        label: /^Cooling/i.test(executorWait)
          ? "Cooling"
          : /^Skip/i.test(executorWait)
            ? "Skip"
            : "Stopped",
        detail: executorWait,
      };
    }
    if (!director) return basePulse;
    if (director.buyNow) {
      const label = sideLabel(director.side);
      const vol = requirements?.volatilityLabel ?? "";
      const gap = signal?.watching.signalGap ?? "—";
      const minGap = requirements?.minColdGap ?? 6;
      const momCap = requirements?.maxMomentumGap ?? 3;
      const pct =
        signal?.digitPercent !== undefined
          ? signal.digitPercent.toFixed(1)
          : "—";
      const power = signal?.power ?? "—";
      const ou = isOverUnderSide(director.side);
      const entry = `ENTRY ${label} ${director.digit}${
        vol ? ` · ${vol}` : ""
      } · gap ${gap}/${ou ? `≤${momCap}` : minGap} · ${
        ou ? "win" : "cold"
      } ${pct}% · power ${power}`;
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
      director.label === "Almost" ||
      director.label === "Cooling"
    ) {
      return {
        ...basePulse,
        mood: director.label === "Cooling" ? ("bounce" as const) : ("watch" as const),
        label: director.label,
        detail: director.detail,
      };
    }
    return {
      ...basePulse,
      label: director.label === "Watch" ? basePulse.label : director.label,
      detail: director.detail || basePulse.detail,
    };
  }, [
    basePulse,
    deskBusy,
    deskBusyDigit,
    deskBusySide,
    director,
    executorWait,
    requirements?.volatilityLabel,
    requirements?.minColdGap,
    requirements?.maxMomentumGap,
    signal,
  ]);

  const alertKeyRef = useRef("");
  const symbolAlertRef = useRef(symbol);
  const [waitMs, setWaitMs] = useState(0);
  const [lastConfirmLabel, setLastConfirmLabel] = useState<string | null>(null);
  const huntStartRef = useRef(Date.now());
  const lastPhaseRef = useRef("");

  useEffect(() => {
    const phase = deskBusy
      ? deskBusy === "buying"
        ? "Buying"
        : "In trade"
      : director?.buyNow
        ? "trade-now"
        : director?.label ?? pulse.label;
    if (phase !== lastPhaseRef.current) {
      if (
        lastPhaseRef.current === "Confirming" &&
        (phase === "Trade now" || phase === "trade-now")
      ) {
        const sec = Math.max(0, Math.floor((Date.now() - huntStartRef.current) / 1000));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        setLastConfirmLabel(`${m}:${s.toString().padStart(2, "0")}`);
      }
      if (
        phase === "In trade" ||
        phase === "Buying" ||
        phase === "Trade now" ||
        phase === "trade-now"
      ) {
        huntStartRef.current = Date.now();
      } else if (
        phase === "Watch" ||
        phase === "Quiet" ||
        phase === "Flat" ||
        phase === "Hunting" ||
        phase === "Almost" ||
        phase === "Building" ||
        phase === "No edge" ||
        phase === "Locking" ||
        phase === "Holding" ||
        phase === "Waiting clean" ||
        phase === "Settling" ||
        phase === "Rotating" ||
        phase === "Studying"
      ) {
        // Reset on settle / hop / new wait — do not let Wait 3:xx pile up
        // across markets while still "Waiting clean".
        if (
          phase === "Settling" ||
          phase === "Rotating" ||
          phase === "Hunting" ||
          lastPhaseRef.current === "Trade now" ||
          lastPhaseRef.current === "trade-now" ||
          lastPhaseRef.current === "Confirming" ||
          lastPhaseRef.current === "In trade" ||
          lastPhaseRef.current === "Buying" ||
          lastPhaseRef.current === "Settling" ||
          lastPhaseRef.current === "Rotating" ||
          lastPhaseRef.current === "Hunting" ||
          lastPhaseRef.current === ""
        ) {
          huntStartRef.current = Date.now();
        }
      }
      lastPhaseRef.current = phase;
    }
  }, [deskBusy, director?.buyNow, director?.label, pulse.label]);

  useEffect(() => {
    const id = window.setInterval(() => {
      // Rotating hops should finish in ~1s — never show Wait 2:xx on a stuck hop.
      if (
        director?.label === "Rotating" &&
        Date.now() - huntStartRef.current > 2_500
      ) {
        huntStartRef.current = Date.now();
      }
      setWaitMs(Date.now() - huntStartRef.current);
    }, 250);
    return () => window.clearInterval(id);
  }, [pulse.label, director?.buyNow, director?.label]);

  const timerText = useMemo(() => {
    const totalSec = Math.max(0, Math.floor(waitMs / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const clock = `${m}:${s.toString().padStart(2, "0")}`;
    if (pulse.label === "Trade now" || director?.buyNow) {
      return lastConfirmLabel ?? `✓ ${clock}`;
    }
    if (pulse.label === "In trade" || pulse.label === "Buying") {
      return `In trade ${clock}`;
    }
    if (director?.label === "Locking") return `Lock ${clock}`;
    if (director?.label === "Confirming") return `Confirm ${clock}`;
    if (director?.label === "Holding") return `Hold ${clock}`;
    if (director?.label === "Rotating") return `Hop ${clock}`;
    if (director?.label === "Hunting") return `Hunt ${clock}`;
    return `Wait ${clock}`;
  }, [
    waitMs,
    lastConfirmLabel,
    pulse.label,
    director?.buyNow,
    director?.label,
  ]);

  useEffect(() => {
    if (symbolAlertRef.current !== symbol) {
      symbolAlertRef.current = symbol;
      alertKeyRef.current = "";
      huntStartRef.current = Date.now();
    }
    const tradeNow =
      pulse.label === "Trade now" ||
      (director?.buyNow === true && pulse.mood === "good");
    if (!tradeNow) {
      if (
        pulse.label !== "Locking" &&
        pulse.label !== "Confirming" &&
        pulse.label !== "Cooling" &&
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

  const ouDesk =
    (signal != null && isOverUnderSide(signal.side)) ||
    (requirements?.side != null && isOverUnderSide(requirements.side));

  // While buying / in trade, the open contract is source of truth — never let
  // a hunting analyzer repaint a different barrier on the grid mid-settle.
  const barrierDigit =
    ouDesk && deskBusy && deskBusyDigit != null
      ? deskBusyDigit
      : ouDesk && (director?.digit ?? signal?.digit) != null
        ? (director?.digit ?? signal!.digit)
        : null;
  const barrierSide =
    ouDesk &&
    deskBusy &&
    deskBusySide != null &&
    isOverUnderSide(deskBusySide)
      ? deskBusySide
      : ouDesk && isOverUnderSide(director?.side ?? signal?.side ?? "DIGITDIFF")
        ? (director?.side ?? signal!.side)
        : null;

  /**
   * What the desk is actually on. The raw blitz signal keeps its own
   * favourite barrier, so reading the card off it showed "Over 2" while the
   * bot bought Under 5 — always follow the directive when there is one.
   */
  const shownSide: OverUnderSide | null =
    barrierSide === "DIGITOVER" || barrierSide === "DIGITUNDER"
      ? barrierSide
      : null;
  const shownBarrier = shownSide != null ? barrierDigit : null;
  /** Live market math for the barrier on screen, not for the blitz pick. */
  const shownScore = useMemo(() => {
    if (!ouDesk || shownSide == null || shownBarrier == null) return null;
    if (digits.length === 0) return null;
    return (
      scoreAllBarriers(digits).find(
        (score) => score.side === shownSide && score.barrier === shownBarrier,
      ) ?? null
    );
  }, [ouDesk, digits, shownSide, shownBarrier]);

  const ranked = [...DIGITS].sort((a, b) =>
    counts[b] !== counts[a] ? counts[b] - counts[a] : a - b,
  );
  const rankOf = (digit: number) => (ranked as readonly number[]).indexOf(digit) + 1;

  return (
    <section className="panel digit-map">
      <div className="panel__head">
        <h2>{ouDesk ? "Last digit prediction" : "Digits"}</h2>
        <span className="digit-map__live">
          <i className={sampleSize > 0 ? "is-on" : ""} aria-hidden="true" />
          {ouDesk && shownSide != null && shownBarrier != null
            ? `${sideLabel(shownSide)} · barrier ${shownBarrier}`
            : `${sampleSize.toLocaleString()} ticks`}
        </span>
      </div>

      {ouDesk ? (
        <div className="ou-mode-toggle" aria-label="Over or Under">
          <span
            className={`ou-mode-toggle__btn${
              barrierSide === "DIGITOVER" ? " is-active" : ""
            }`}
          >
            Over
          </span>
          <span
            className={`ou-mode-toggle__btn${
              barrierSide === "DIGITUNDER" ? " is-active" : ""
            }`}
          >
            Under
          </span>
          <em>
            {barrierSide === "DIGITOVER"
              ? "Wins when last digit is over the barrier"
              : barrierSide === "DIGITUNDER"
                ? "Wins when last digit is under the barrier"
                : "Analyzer picks Over or Under"}
          </em>
        </div>
      ) : null}

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
          const isBarrier = ouDesk && barrierDigit === digit;
          const selected =
            selectedDigit === digit ||
            entryDigit === digit ||
            isBarrier === true;
          const live = latestDigit === digit;
          const pulsing = pulseDigit === digit;
          const hovering = hoverDigit === digit;
          const tone = tones[digit];
          const rank = rankOf(digit);
          const inWinZone =
            ouDesk &&
            barrierDigit !== null &&
            barrierSide != null &&
            (barrierSide === "DIGITOVER"
              ? digit > barrierDigit
              : digit < barrierDigit);
          const ouSide: OverUnderSide | null =
            ouDesk &&
            (barrierSide === "DIGITOVER" || barrierSide === "DIGITUNDER")
              ? barrierSide
              : ouDesk && signal && isOverUnderSide(signal.side)
                ? (signal.side as OverUnderSide)
                : null;
          const pay =
            ouSide != null
              ? ouBarrierPay(ouSide, digit, stake, contracts)
              : null;
          const lockingPick =
            isBarrier &&
            (director?.buyNow === true ||
              director?.label === "Locking" ||
              director?.label === "Confirming");

          return (
            <button
              type="button"
              key={digit}
              role="listitem"
              className={[
                "digit-tile",
                selected ? "digit-tile--selected" : "",
                entryDigit === digit || isBarrier ? "digit-tile--entry" : "",
                live ? "digit-tile--live" : "",
                pulsing ? "digit-tile--pulse" : "",
                hovering ? "digit-tile--hover" : "",
                inWinZone ? "digit-tile--winzone" : "",
                ouDesk && !inWinZone && !isBarrier ? "digit-tile--losezone" : "",
                pay?.tradable ? "digit-tile--tradable" : "",
                lockingPick ? "digit-tile--locking" : "",
                `digit-tile--${tone}`,
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelectDigit(digit)}
              onPointerEnter={() => setHoverDigit(digit)}
              onPointerLeave={() =>
                setHoverDigit((d) => (d === digit ? null : d))
              }
              aria-pressed={selected}
              aria-label={
                ouDesk
                  ? `Barrier ${digit}${
                      pay
                        ? `, payout ${pay.payout.toFixed(2)}x, win plus ${pay.win.toFixed(2)}`
                        : ""
                    }${isBarrier ? ", selected" : ""}`
                  : `Digit ${digit}, ${pct.toFixed(1)} percent, ${count} of ${sampleSize}`
              }
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

              {ouDesk ? (
                <span
                  className={`digit-tile__pay${
                    isBarrier || lockingPick ? " is-active" : ""
                  }${pay?.tradable ? " is-tradable" : ""}`}
                >
                  {pay ? (
                    <>
                      <b>×{pay.payout.toFixed(2)}</b>
                      <em>+{pay.win.toFixed(2)}</em>
                    </>
                  ) : (
                    <em className="is-na">—</em>
                  )}
                </span>
              ) : null}

              {hovering ? (
                <span className="digit-tile__tip" role="tooltip">
                  <strong>
                    {ouDesk && ouSide
                      ? `${sideLabel(ouSide)} ${digit}`
                      : ouDesk
                        ? `Barrier ${digit}`
                        : `Digit ${digit}`}
                  </strong>
                  {ouDesk && pay ? (
                    <>
                      <em>
                        Pay ×{pay.payout.toFixed(2)} · one win +{pay.win.toFixed(2)}
                      </em>
                      <em>
                        Fair ~{pay.fairPct.toFixed(0)}% · stake{" "}
                        {(stake * Math.max(1, contracts)).toFixed(2)}
                      </em>
                      <em>
                        {isBarrier || lockingPick
                          ? director?.label === "Locking" ||
                            director?.label === "Confirming"
                            ? `${director.label} this barrier`
                            : "Selected barrier"
                          : pay.tradable
                            ? "Blitz tradable barrier"
                            : "Valid barrier · lower Blitz priority"}
                      </em>
                    </>
                  ) : (
                    <em>
                      {count.toLocaleString()} / {sampleSize.toLocaleString()} ·{" "}
                      {pct.toFixed(2)}%
                    </em>
                  )}
                  {!ouDesk ? (
                    <em>
                      {vsFair >= 0 ? "+" : ""}
                      {vsFair.toFixed(1)} vs 10% · {rankLabel(rank)}
                    </em>
                  ) : null}
                  <em>
                    Gap {gap === null ? "absent" : `${gap} tick${gap === 1 ? "" : "s"}`}
                    {!ouDesk &&
                      (hottest[0] === digit
                        ? " · hot"
                        : coldest[0] === digit
                          ? " · cold"
                          : "")}
                  </em>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {ouDesk && signal && shownSide != null && shownBarrier != null ? (
        <div className="ou-digit-readout" aria-live="polite">
          <div className="ou-digit-readout__pick">
            <strong>
              {sideLabel(shownSide)} {shownBarrier}
            </strong>
            <span className={`ou-digit-readout__conf is-${signal.confidence}`}>
              {signal.confidence}
            </span>
            {botBarrier != null ? (
              botBarrier === shownBarrier ? (
                <span className="ou-digit-readout__sync is-ok">
                  Following analyzer
                </span>
              ) : (
                <span className="ou-digit-readout__sync">
                  Bot → {botBarrier}
                </span>
              )
            ) : null}
          </div>
          <div className="ou-digit-readout__metrics">
            {shownScore ? (
              <>
                <span>
                  <em>Edge</em>
                  <b>
                    {shownScore.microEdge >= 0 ? "+" : ""}
                    {shownScore.microEdge.toFixed(0)}
                  </b>
                </span>
                <span>
                  <em>EV</em>
                  <b>
                    {shownScore.microEv >= 0 ? "+" : ""}
                    {shownScore.microEv.toFixed(2)}
                  </b>
                </span>
                <span>
                  <em>Streak</em>
                  <b>{shownScore.streak}</b>
                </span>
              </>
            ) : null}
            <span>
              <em>Power</em>
              <b>{signal.power}</b>
            </span>
            {botTakeProfit != null && botTakeProfit > 0 ? (
              <span>
                <em>TP</em>
                <b>+{botTakeProfit.toFixed(2)}</b>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

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
        {ouDesk && sweep ? (
          <div
            className={`digit-map__sweep ${sweep.proven ? "is-proven" : ""}`}
            title="Every volatility index, best barrier of 8, lower bound vs payout break-even, corrected for the full 80-candidate search"
          >
            <strong>
              Deep sweep · {sweep.scannedMarkets} markets ×{" "}
              {sweep.ticksPerMarket} ticks
            </strong>
            {sweep.proven ? (
              <span className="digit-map__sweep-verdict is-proven">
                PROVEN · {volShort(sweep.proven.symbol)}{" "}
                {sideLabel(sweep.proven.side)} {sweep.proven.barrier} · low{" "}
                {sweep.proven.verdict.lowerPercent.toFixed(1)}% &gt; need{" "}
                {sweep.proven.verdict.needPercent.toFixed(1)}%
              </span>
            ) : sweep.closest ? (
              <span className="digit-map__sweep-verdict">
                no edge on the board · closest {volShort(sweep.closest.symbol)}{" "}
                {sideLabel(sweep.closest.side)} {sweep.closest.barrier} ·{" "}
                {sweep.closest.verdict.observedPercent.toFixed(1)}% · low{" "}
                {sweep.closest.verdict.lowerPercent.toFixed(1)}% vs need{" "}
                {sweep.closest.verdict.needPercent.toFixed(1)}%
              </span>
            ) : (
              <span className="digit-map__sweep-verdict">reading…</span>
            )}
            <span className="digit-map__sweep-age">
              {sweepScanning ? "re-reading…" : sweepAge(sweep.scannedAt)}
            </span>
            {onEntryModeChange ? (
              <button
                type="button"
                className={`digit-map__sweep-mode ${entryMode === "proven" ? "" : "is-momentum"}`}
                title={ENTRY_MODE_HELP[entryMode]}
                onClick={() => onEntryModeChange(NEXT_ENTRY_MODE[entryMode])}
              >
                Mode · {ENTRY_MODE_LABEL[entryMode]}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="digit-map__legend">
          {ouDesk ? (
            <>
              <span className="is-high">Hot %</span>
              <span className="is-low">Cold %</span>
              <span>×pay · +win</span>
              <span>Barrier pick</span>
            </>
          ) : (
            <>
              <span className="is-high">Hot</span>
              <span className="is-low">Cold</span>
              <span>Fair 10%</span>
            </>
          )}
          {latestDigit !== null && latestDigit !== undefined ? (
            <span className="digit-map__legend-live">Live · {latestDigit}</span>
          ) : null}
          <div className="digit-map__legend-pace-row">
            <span className="digit-map__legend-need">{pulse.need}</span>
            {onAnalyzerPaceChange && differsPaceSwitch ? (
              <button
                type="button"
                className={`digit-map__pace-switch ${
                  pace.recommended ? "is-recommended" : ""
                }`}
                title={`Switch to ${otherPace.label}`}
                aria-label={`Analyzer pace ${pace.shortLabel}. Switch to ${otherPace.shortLabel}`}
                onClick={() => onAnalyzerPaceChange(otherPace.id)}
              >
                <span className="digit-map__pace-switch-label">
                  {pace.shortLabel}
                  {pace.recommended ? <em>rec</em> : null}
                </span>
                <span className="digit-map__pace-switch-to">
                  → {otherPace.shortLabel}
                </span>
              </button>
            ) : pace.id === "matches-firm" || pace.id === "overunder-firm" ? (
              <span
                className="digit-map__pace-switch is-recommended"
                title={pace.blurb}
              >
                <span className="digit-map__pace-switch-label">
                  {pace.shortLabel}
                  <em>{pace.id === "overunder-firm" ? "blitz" : "firm"}</em>
                </span>
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
