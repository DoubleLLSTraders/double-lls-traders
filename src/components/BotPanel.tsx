import { DeskSwitch } from "./DeskSwitch";
import { ModeChooser } from "./ModeChooser";
import { OverUnderChooser } from "./OverUnderChooser";
import { CleanNumberInput } from "./CleanNumberInput";
import { useMemo, useState, type ReactNode } from "react";
import type { AppConfig } from "../lib/config";
import type { BotSession, BotSettings } from "../lib/bot/types";
import {
  diffExpectedValue,
  effectiveDiffMultiple,
  overUnderPayoutMultiplier,
  profitRate,
  type PerformanceStats,
} from "../lib/bot/performance";
import {
  MIN_STAKE,
  capStake,
  exposureCap,
  recoveryRequirements,
  recoveryStake,
  stakeFromRisk,
} from "../lib/bot/gates";
import {
  ANALYZER_PACES,
  MATCHES_ANALYZER_PACES,
  OVER_UNDER_ANALYZER_PACES,
  type AnalyzerPaceId,
} from "../lib/analysis/analyzerPace";
import { deskOf, sideLabel, sideShort } from "../lib/analysis/contractSide";
import type { TradeDesk } from "../lib/analysis/contractSide";
import type { ContractSide } from "../lib/analysis/signal";
import {
  liveWinPnl,
  payoutCtxFromSettings,
  profitLimitsForStake,
  resolveLiveStake,
  runsForTakeProfit,
} from "../lib/bot/liveProfile";
import {
  formatSessionDuration,
  OU_BULK_SESSION_PRESETS,
  OU_OVER_BARRIERS,
  OU_UNDER_BARRIERS,
  ouBulkPresetForRuns,
  sessionHoursFromParts,
  sessionPartsFromHours,
  type OuBulkSessionId,
} from "../lib/bot/overUnderProfile";
import { fairWinProb } from "../lib/analysis/overUnder";

export type { BotSettings, ContractSide };

interface BotPanelProps {
  config: AppConfig;
  selectedDigit: number | null;
  currency: string;
  balance: number | null;
  connectionReady: boolean;
  settings: BotSettings;
  session: BotSession;
  performance: PerformanceStats;
  /** Baskets settled since the last Start. */
  runsThisStart?: number;
  /** P/L since the last Start. */
  pnlThisStart?: number;
  log: string[];
  countdown: number | null;
  armProgress: number;
  signalLabel: string;
  scanning?: boolean;
  /** AI Operator owns the bot — block manual Start. */
  operatorControlled?: boolean;
  isVirtual?: boolean;
  differsFastActive?: boolean;
  matchesFirmActive?: boolean;
  overUnderActive?: boolean;
  liveProfileActive?: boolean;
  tradingMode?: AppConfig["mode"];
  onApplyLiveSettings?: () => void;
  /** Open live contract or buy in flight — Stop is blocked. */
  settling?: boolean;
  onChange: (next: BotSettings) => void;
  onSelectSide: (side: ContractSide) => void;
  onSelectDesk?: (desk: TradeDesk) => void;
  onRestoreDiffersFast?: () => void;
  onRestoreMatchesFirm?: () => void;
  onRestoreOverUnder?: () => void;
  onToggle: () => void;
}

/**
 * Stake sizing is the only lever on Differs that changes the outcome at all.
 *
 * Deriv rounds each contract's payout down to a whole cent, so the edge is not
 * flat across stakes: scripts/check-beststake measured 1.0982x at 2.85 against
 * 1.0500x at 0.40 — a 4.34 point swing per trade for the identical bet. Two
 * ways to fall into the bad band: splitting a basket into small legs, or just
 * typing a small stake. Both are called out here.
 */
const EFFICIENT_MULTIPLE = 1.09;
/** Best measured stake under ~2 that stays in the efficient band. */
const SUGGESTED_STAKE = 1.75;

function withStakeLinkedLimits(
  settings: BotSettings,
  stake: number,
  balance: number | null,
  tradingMode: AppConfig["mode"],
  isVirtual: boolean,
): BotSettings {
  const bulkId = ouBulkPresetForRuns(
    settings.maxRuns,
    settings.maxRunsManual,
    settings.sessionHours,
  );
  // Hour bulk: stake change must rebuild TP/SL for the new stake (keep the hour cap).
  if (
    deskOf(settings.side) === "overunder" &&
    bulkId !== "quick" &&
    settings.maxRunsManual === true
  ) {
    return applyOuBulkSession(
      { ...settings, stake, maxStake: Math.max(settings.maxStake, stake) },
      bulkId,
      isVirtual,
    );
  }

  const committed = Math.max(MIN_STAKE, Number(stake.toFixed(2)));
  const next = {
    ...settings,
    stake: committed,
    maxStake: Math.max(settings.maxStake, committed),
    // Timed OU keeps manual TP marker; quick/auto TP resyncs from this stake.
    takeProfitManual:
      deskOf(settings.side) === "overunder" &&
      (settings.sessionHours ?? 0) > 0
        ? true
        : settings.takeProfitManual === true,
  };
  const ctx = payoutCtxFromSettings(next);
  const preserveRuns =
    next.maxRunsManual === true
      ? { preserveMaxRuns: next.maxRuns }
      : undefined;

  if (tradingMode === "live" && balance !== null) {
    // Cap / exposure only — never raise the stake the user typed (e.g. 0.35 → 1.75).
    const resolved = resolveLiveStake(next, balance, isVirtual);
    const limits = profitLimitsForStake(
      committed,
      next.contracts,
      isVirtual,
      next.takeProfitManual === true ? next.takeProfit : undefined,
      ctx,
      preserveRuns,
    );
    return {
      ...next,
      stake: committed,
      maxExposurePercent: Math.max(
        resolved.maxExposurePercent,
        next.maxExposurePercent,
      ),
      maxStake: Math.max(next.maxStake, committed),
      ...limits,
      takeProfit:
        next.takeProfitManual === true ? next.takeProfit : limits.takeProfit,
      dailyLossLimit: Math.max(next.dailyLossLimit, limits.dailyLossLimit),
    };
  }

  const limits = profitLimitsForStake(
    committed,
    next.contracts,
    isVirtual,
    next.takeProfitManual === true ? next.takeProfit : undefined,
    ctx,
    preserveRuns,
  );
  return {
    ...next,
    ...limits,
    takeProfit:
      next.takeProfitManual === true ? next.takeProfit : limits.takeProfit,
    dailyLossLimit: Math.max(next.dailyLossLimit, limits.dailyLossLimit),
  };
}

function applyOuBulkSession(
  settings: BotSettings,
  presetId: OuBulkSessionId,
  isVirtual: boolean,
  customDurationHours?: number,
): BotSettings {
  const preset =
    OU_BULK_SESSION_PRESETS.find((p) => p.id === presetId) ??
    OU_BULK_SESSION_PRESETS[0];
  const ctx = payoutCtxFromSettings(settings);

  if (preset.id === "quick") {
    const limits = profitLimitsForStake(
      settings.stake,
      settings.contracts,
      isVirtual,
      undefined,
      ctx,
    );
    return {
      ...settings,
      ...limits,
      sessionHours: 0,
      takeProfitManual: false,
      maxRunsManual: false,
      dailyLossLimit: Math.max(settings.dailyLossLimit, limits.dailyLossLimit),
    };
  }

  // Full timed Start: stake every entry until the wall clock ends.
  // TP may stay as a comfort marker — executor ignores TP stops while timed.
  let durationHours =
    preset.id === "custom"
      ? (customDurationHours ??
        (settings.sessionHours &&
        settings.sessionHours > 0 &&
        Math.abs(settings.sessionHours - 1) > 1e-9 &&
        Math.abs(settings.sessionHours - 4) > 1e-9 &&
        Math.abs(settings.sessionHours - 8) > 1e-9
          ? settings.sessionHours
          : 0.5))
      : preset.hours;
  // Minimum 1 minute.
  durationHours = Math.max(1 / 60, durationHours);

  const softSl = Number((settings.stake * 4).toFixed(2));
  const hourCap = Math.max(settings.maxTradesPerHour || 36, 36);
  const dayPad = Math.max(24, Math.ceil(durationHours * hourCap) + 24);

  return {
    ...settings,
    sessionHours: durationHours,
    maxRuns: 0,
    maxRunsManual: true,
    takeProfitManual: true,
    dailyProfitTarget: 0,
    stopLoss: softSl,
    dailyLossLimit: Math.max(settings.dailyLossLimit, softSl * 2, 5),
    maxTradesPerDay: Math.max(settings.maxTradesPerDay, dayPad),
    maxTradesPerHour: hourCap,
  };
}

function OuProfitMath({
  settings,
  currency,
  runsThisStart,
}: {
  settings: BotSettings;
  currency: string;
  runsThisStart: number;
}) {
  const side =
    settings.side === "DIGITUNDER" ? "DIGITUNDER" : "DIGITOVER";
  const barrier = settings.prediction;
  const payout = overUnderPayoutMultiplier(side, barrier);
  const fair = fairWinProb(side, barrier) * 100;
  const margin = payout - 1;
  const marginPct = margin * 100;
  const exposure = settings.stake * Math.max(1, settings.contracts);
  const winPnl = liveWinPnl(
    settings.stake,
    settings.contracts,
    payoutCtxFromSettings(settings),
  );
  const winsForTp =
    settings.takeProfit > 0 && winPnl > 0
      ? runsForTakeProfit(
          settings.takeProfit,
          settings.stake,
          settings.contracts,
          payoutCtxFromSettings(settings),
        )
      : 0;
  const winsWhen =
    side === "DIGITOVER"
      ? `last digit > ${barrier}`
      : `last digit < ${barrier}`;
  const tradeCap = settings.maxRuns;
  const bulkHours = settings.sessionHours ?? 0;
  const bulk = ouBulkPresetForRuns(
    tradeCap,
    settings.maxRunsManual,
    bulkHours,
  );
  const durationLabel = formatSessionDuration(bulkHours);

  return (
    <div className="bot-ou-math" aria-label="Over Under profit calculation">
      <strong className="bot-ou-math__title">Profit calculation</strong>
      <p className="bot-ou-math__contract">
        {sideLabel(side)} {barrier} wins when {winsWhen}. Fair ~{fair.toFixed(0)}%
        · payout ×{payout.toFixed(2)} ({marginPct.toFixed(0)}% margin).
      </p>
      <ul className="bot-ou-math__list">
        <li>
          <span>One win</span>
          <em>
            stake {exposure.toFixed(2)} × {marginPct.toFixed(0)}% = +
            {winPnl.toFixed(2)} {currency}
          </em>
        </li>
        <li>
          <span>Session</span>
          <em>
            {bulkHours > 0
              ? `full ${durationLabel} clock · stake ${exposure.toFixed(2)} every trade`
              : settings.takeProfit > 0
                ? `Quick · TP +${settings.takeProfit.toFixed(2)} (~${winsForTp} wins)`
                : "Quick · no TP"}
          </em>
        </li>
        <li>
          <span>Stops when</span>
          <em>
            {bulkHours > 0
              ? `${durationLabel} ends · or SL −${settings.stopLoss.toFixed(2)} · or Stop · now ${runsThisStart} trades`
              : tradeCap > 0
                ? `TP / run cap ${tradeCap} / SL · now ${runsThisStart}/${tradeCap}`
                : `TP / SL · now ${runsThisStart} trades`}
          </em>
        </li>
      </ul>
      <p className="bot-ou-math__note">
        {bulkHours > 0
          ? `${durationLabel} timed mode ignores take profit as a stop. If P/L passes TP it keeps trading until the clock finishes.`
          : bulk === "quick"
            ? "Quick mode stops on take profit (one barrier win by default)."
            : "Whichever limit hits first stops the Start."}
      </p>
    </div>
  );
}

function PayoutNotice({ settings }: { settings: BotSettings }) {
  const risk = settings.stake * settings.contracts;
  const now = diffExpectedValue(settings.stake);
  const consolidated = diffExpectedValue(risk);
  const gain = (consolidated - now) * 100;
  const worthConsolidating = settings.contracts > 1 && gain > 0.25;

  const multiple = effectiveDiffMultiple(settings.stake);
  const inefficient = !worthConsolidating && multiple < EFFICIENT_MULTIPLE;
  const better = diffExpectedValue(SUGGESTED_STAKE);

  return (
    <p className={`bot-payout ${worthConsolidating || inefficient ? "is-warn" : ""}`}>
      {worthConsolidating
        ? `Payout leak · ${settings.contracts} legs of ${settings.stake.toFixed(
            2,
          )} pay ${multiple.toFixed(4)}x each, so this basket runs at ${(now * 100).toFixed(
            2,
          )}% per trade. One contract of ${risk.toFixed(
            2,
          )} risks the same money at ${effectiveDiffMultiple(risk).toFixed(
            4,
          )}x, worth ${gain.toFixed(2)} points more per trade.`
        : inefficient
          ? `Bad stake size · ${settings.stake.toFixed(2)} pays only ${multiple.toFixed(
              4,
            )}x once Deriv rounds to the cent, so you lose ${(now * 100).toFixed(
              2,
            )}% per trade instead of ${(better * 100).toFixed(
              2,
            )}% at ${SUGGESTED_STAKE.toFixed(2)}. Same bet, ${(
              (better - now) *
              100
            ).toFixed(2)} points cheaper.`
          : `Payout · ${multiple.toFixed(4)}x per contract, ${(now * 100).toFixed(
              2,
            )}% expected per trade at a fair 90% win rate.`}
    </p>
  );
}

/**
 * The ceiling on a single basket, stated in the money it actually risks.
 *
 * A percentage on its own is easy to misread, so this spells out what one
 * losing trade costs against the balance in the account right now.
 */
function ExposureNotice({
  settings,
  balance,
  currency,
  busy,
  onChange,
}: {
  settings: BotSettings;
  balance: number | null;
  currency: string;
  busy: boolean;
  onChange: (settings: BotSettings) => void;
}) {
  const cap = exposureCap(settings, balance);
  const legs = Math.max(1, settings.contracts);
  const floor = MIN_STAKE * legs;
  const percent = Number.isFinite(settings.maxExposurePercent)
    ? settings.maxExposurePercent
    : 0;

  return (
    <div className="bot-exposure">
      <label className="bot-exposure__field">
        <span>Max risk per trade</span>
        <div className="bot-risk__input-row">
          <CleanNumberInput
            min={0}
            max={100}
            step={0.5}
            value={percent}
            disabled={busy}
            onCommit={(maxExposurePercent) =>
              onChange({ ...settings, maxExposurePercent })
            }
          />
          <em>% of balance</em>
        </div>
      </label>
      <p
        className={`bot-exposure__note ${
          percent <= 0 || (cap && !cap.affordable) ? "is-warn" : "is-ok"
        }`}
      >
        {percent <= 0
          ? "Off · a losing streak can stake the whole account. Set this to 2% to keep any single loss survivable."
          : balance === null
            ? `Waiting for balance · baskets will be capped at ${percent}% of it.`
            : cap && !cap.affordable
              ? `Blocked · the smallest basket Deriv accepts is ${floor.toFixed(
                  2,
                )} ${currency}, which is ${((floor / balance) * 100).toFixed(
                  0,
                )}% of your ${balance.toFixed(2)}. Trading ${percent}% per basket needs at least ${(
                  (floor * 100) /
                  percent
                ).toFixed(2)} ${currency} in the account.`
              : `Capped · one basket risks at most ${cap?.budget.toFixed(2)} ${currency} of your ${balance.toFixed(
                  2,
                )}. A loss costs that and no more, whatever the martingale asks for.`}
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bot-section">
      <div className="bot-section__head">
        <h3>{title}</h3>
      </div>
      {children}
    </section>
  );
}

export function BotPanel({
  config,
  selectedDigit,
  currency,
  balance,
  connectionReady,
  settings,
  session,
  performance,
  runsThisStart = 0,
  pnlThisStart = 0,
  log,
  countdown,
  armProgress,
  signalLabel,
  scanning = false,
  operatorControlled = false,
  differsFastActive = false,
  matchesFirmActive = false,
  overUnderActive = false,
  isVirtual = true,
  liveProfileActive = false,
  tradingMode = "paper",
  onApplyLiveSettings,
  settling = false,
  onChange,
  onSelectSide,
  onSelectDesk,
  onRestoreDiffersFast,
  onRestoreMatchesFirm,
  onRestoreOverUnder,
  onToggle,
}: BotPanelProps) {
  const tradeDesk = deskOf(settings.side);
  const isOverUnderDesk = tradeDesk === "overunder";
  const isMatchesSide = settings.side === "DIGITMATCH";
  /** Keep Custom clock open even if duration equals 1h / 4h / 8h. */
  const [customClockOpen, setCustomClockOpen] = useState(() => {
    if (deskOf(settings.side) !== "overunder") return false;
    return (
      ouBulkPresetForRuns(
        settings.maxRuns,
        settings.maxRunsManual,
        settings.sessionHours,
      ) === "custom"
    );
  });
  const paceChoices = isOverUnderDesk
    ? OVER_UNDER_ANALYZER_PACES
    : isMatchesSide
      ? MATCHES_ANALYZER_PACES
      : ANALYZER_PACES;
  // Mirrors the bot's own sizing, cap included, so the figure on screen is
  // the figure that will actually be staked.
  const nextStake = useMemo(() => {
    const wanted =
      session.martingaleSteps > 0
        ? session.currentStake
        : stakeFromRisk(settings, balance, settings.maxStake);
    return capStake(wanted, settings, balance);
  }, [
    session.martingaleSteps,
    session.currentStake,
    settings,
    balance,
  ]);

  const totalExposure = useMemo(
    () => nextStake * settings.contracts,
    [nextStake, settings.contracts],
  );

  // What one basket must win back, and whether the caps allow it.
  const recovery = useMemo(() => {
    const risked = settings.stake * settings.contracts;
    const plan = recoveryStake(
      risked,
      settings.side,
      settings.contracts,
      settings.stake,
      settings.maxStake,
    );
    return {
      risked,
      plan,
      fitsDaily: plan.exposure <= settings.dailyLossLimit - risked,
      needs: recoveryRequirements(settings),
    };
  }, [
    settings.stake,
    settings.contracts,
    settings.side,
    settings.maxStake,
    settings.dailyLossLimit,
  ]);

  const arming = countdown !== null;
  const busy = settings.running || arming || scanning;

  const canStart =
    settings.prediction >= 0 &&
    settings.prediction <= 9 &&
    settings.stake > 0 &&
    settings.contracts >= 1 &&
    (config.mode === "paper" || connectionReady);

  const contractName = sideLabel(settings.side);

  return (
    <aside className="bot-panel bot-panel--full">
      <div className="bot-panel__head">
        <div>
          <h2>Trade bot</h2>
          <p>
            {isOverUnderDesk
              ? "Over/Under · barrier · risk · filters"
              : "Matches · Differs · risk · filters"}
          </p>
        </div>
        <div className="bot-panel__badges">
          <span className={`badge ${config.mode === "paper" ? "badge--paper" : "badge--live"}`}>
            {config.mode === "paper" ? "Paper" : "Live"}
          </span>
          <span className={`badge ${busy ? "badge--demo" : "badge--paper"}`}>
            {settings.running ? "Running" : arming ? "Arming" : "Idle"}
          </span>
        </div>
      </div>

      <Section title="Session">
        <div className="bot-status-row">
          <div>
            <span>Contract</span>
            <strong>{contractName}</strong>
          </div>
          <div>
            <span>{isOverUnderDesk ? "Barrier" : "Digit"}</span>
            <strong>{settings.prediction}</strong>
          </div>
          <div>
            <span>Open</span>
            <strong>
              {session.open
                ? `${sideShort(session.open.side)}${session.open.digit}`
                : "Flat"}
            </strong>
          </div>
          <div>
            <span>{session.open ? "Open stake" : "Next stake"}</span>
            <strong>
              {session.open
                ? session.open.stake.toFixed(2)
                : nextStake.toFixed(2)}
            </strong>
            {!session.open && Math.abs(nextStake - settings.stake) > 0.009 ? (
              <small className="bot-field__hint">
                capped from {settings.stake.toFixed(2)}
              </small>
            ) : null}
          </div>
          <div>
            <span>{arming ? "Timer" : "Session P/L"}</span>
            <strong className={arming ? "is-up" : session.pnl >= 0 ? "is-up" : "is-down"}>
              {arming
                ? `${countdown}s`
                : `${session.pnl >= 0 ? "+" : ""}${session.pnl.toFixed(2)}`}
            </strong>
          </div>
        </div>
      </Section>

      {arming ? (
        <div className="bot-timer" aria-live="polite">
          <div className="bot-timer__ring">
            <strong>{countdown}</strong>
            <span>sec</span>
          </div>
          <div className="bot-timer__copy">
            <span>Arm timer</span>
            <p>
              Waiting before the first entries. Watching analyzer signal{" "}
              <strong>{signalLabel}</strong> for <strong>{contractName}</strong>. At 0 the
              bot feeds that setup and may open if all filters pass.
            </p>
            <div className="bot-timer__bar" aria-hidden="true">
              <i style={{ width: `${Math.min(100, Math.max(0, armProgress * 100))}%` }} />
            </div>
          </div>
        </div>
      ) : null}

      {onSelectDesk ? (
        <DeskSwitch
          value={tradeDesk}
          disabled={Boolean(settling)}
          onChange={onSelectDesk}
        />
      ) : null}

      {isOverUnderDesk ? (
        <OverUnderChooser
          value={settings.side}
          auto={settings.autoSide}
          disabled={Boolean(settling)}
          onChange={onSelectSide}
          onEnableAuto={() =>
            onChange({ ...settings, autoSide: true, autoFollow: true })
          }
        />
      ) : (
        <ModeChooser
          value={settings.side === "DIGITMATCH" ? "DIGITMATCH" : "DIGITDIFF"}
          auto={settings.autoSide}
          // Only lock while a contract is open — never during scan/hunt.
          disabled={Boolean(settling)}
          onChange={onSelectSide}
          onEnableAuto={() =>
            onChange({ ...settings, autoSide: true, autoFollow: true })
          }
        />
      )}

      <Section title="Order">
        <div className="bot-panel__grid">
          <label className="bot-field">
            <span>{isOverUnderDesk ? "Barrier digit" : "Prediction digit"}</span>
            <select
              value={
                isOverUnderDesk
                  ? ((settings.side === "DIGITUNDER"
                      ? OU_UNDER_BARRIERS
                      : OU_OVER_BARRIERS) as readonly number[]
                    ).includes(settings.prediction)
                    ? settings.prediction
                    : settings.side === "DIGITUNDER"
                      ? 8
                      : 1
                  : settings.prediction
              }
              onChange={(event) => {
                const prediction = Number(event.target.value);
                const next = {
                  ...settings,
                  prediction,
                  autoFollow: false,
                };
                if (!isOverUnderDesk) {
                  onChange(next);
                  return;
                }
                onChange(
                  withStakeLinkedLimits(
                    next,
                    next.stake,
                    balance,
                    tradingMode,
                    isVirtual,
                  ),
                );
              }}
            >
              {isOverUnderDesk
                ? (settings.side === "DIGITUNDER"
                    ? [...OU_UNDER_BARRIERS]
                    : [...OU_OVER_BARRIERS]
                  ).map((digit) => {
                    const ouSide =
                      settings.side === "DIGITUNDER"
                        ? "DIGITUNDER"
                        : "DIGITOVER";
                    const mult = overUnderPayoutMultiplier(ouSide, digit);
                    const fair = fairWinProb(ouSide, digit) * 100;
                    return (
                      <option key={digit} value={digit}>
                        {digit} · ×{mult.toFixed(2)} · fair {fair.toFixed(0)}%
                      </option>
                    );
                  })
                : Array.from({ length: 10 }, (_, digit) => (
                    <option key={digit} value={digit}>
                      {digit}
                    </option>
                  ))}
            </select>
            {isOverUnderDesk ? (
              <small className="bot-field__hint">
                {settings.autoFollow
                  ? "Analyzer follows live Over/Under barrier"
                  : settings.side === "DIGITOVER"
                    ? "Wins when last digit is over this barrier"
                    : "Wins when last digit is under this barrier"}
              </small>
            ) : selectedDigit !== null ? (
              <button
                type="button"
                className="bot-link"
                onClick={() =>
                  onChange({
                    ...settings,
                    prediction: selectedDigit,
                    autoFollow: false,
                  })
                }
              >
                Use market digit {selectedDigit}
              </button>
            ) : null}
          </label>

          <label className="bot-field">
            <span>Duration (ticks)</span>
            <CleanNumberInput
              min={1}
              max={10}
              integer
              value={settings.duration}
              onCommit={(duration) => onChange({ ...settings, duration })}
            />
          </label>

          <label className="bot-field">
            <span>Base stake</span>
            <CleanNumberInput
              min={0.35}
              step={0.01}
              value={settings.stake}
              onCommit={(stake) =>
                onChange(
                  withStakeLinkedLimits(
                    settings,
                    stake,
                    balance,
                    tradingMode,
                    isVirtual,
                  ),
                )
              }
            />
          </label>

          <label className="bot-field">
            <span>Risk % of balance</span>
            <CleanNumberInput
              min={0}
              max={5}
              step={0.1}
              value={settings.riskPercent}
              onCommit={(riskPercent) => onChange({ ...settings, riskPercent })}
            />
          </label>

          <label className="bot-field">
            <span>Bulk contracts</span>
            <CleanNumberInput
              min={1}
              max={10}
              integer
              value={settings.contracts}
              onCommit={(contracts) =>
                onChange(
                  withStakeLinkedLimits(
                    { ...settings, contracts },
                    settings.stake,
                    balance,
                    tradingMode,
                    isVirtual,
                  ),
                )
              }
            />
          </label>
        </div>

        {settings.side === "DIGITDIFF" ? (
          <PayoutNotice settings={settings} />
        ) : isOverUnderDesk ? (
          <OuProfitMath
            settings={settings}
            currency={currency}
            runsThisStart={runsThisStart}
          />
        ) : null}

        <div className="bot-panel__grid">

          <label className="bot-field">
            <span>Arm timer (sec)</span>
            <CleanNumberInput
              min={0}
              max={120}
              integer
              value={arming && countdown !== null ? countdown : settings.armSeconds}
              disabled={busy}
              onCommit={(armSeconds) => onChange({ ...settings, armSeconds })}
            />
          </label>
        </div>
      </Section>

      <Section title="Run limits">
        {isOverUnderDesk ? (
          <div className="bot-bulk-hours" aria-label="Bulk session length">
            <span className="bot-bulk-hours__label">Bulk session</span>
            <div className="bot-bulk-hours__row">
              {OU_BULK_SESSION_PRESETS.map((preset) => {
                const presetId = ouBulkPresetForRuns(
                  settings.maxRuns,
                  settings.maxRunsManual,
                  settings.sessionHours,
                );
                const customOpen =
                  customClockOpen || presetId === "custom";
                const active =
                  preset.id === "custom"
                    ? customOpen
                    : !customOpen && presetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`bot-bulk-hours__btn${active ? " is-active" : ""}`}
                    disabled={busy}
                    onClick={() => {
                      if (preset.id === "custom") {
                        setCustomClockOpen(true);
                        onChange(
                          applyOuBulkSession(
                            settings,
                            "custom",
                            isVirtual,
                          ),
                        );
                        return;
                      }
                      setCustomClockOpen(false);
                      onChange(
                        applyOuBulkSession(settings, preset.id, isVirtual),
                      );
                    }}
                  >
                    {preset.label}
                    {preset.id === "quick" ? (
                      <em>TP stops</em>
                    ) : preset.id === "custom" ? (
                      <em>
                        {customOpen && (settings.sessionHours ?? 0) > 0
                          ? formatSessionDuration(settings.sessionHours ?? 0)
                          : "set clock"}
                      </em>
                    ) : (
                      <em>full clock · TP ignored</em>
                    )}
                  </button>
                );
              })}
            </div>
            {customClockOpen ||
            ouBulkPresetForRuns(
              settings.maxRuns,
              settings.maxRunsManual,
              settings.sessionHours,
            ) === "custom" ? (
              <div className="bot-bulk-clock" aria-label="Custom session clock">
                <div className="bot-bulk-clock__face">
                  <label className="bot-bulk-clock__unit">
                    <span>Hours</span>
                    <CleanNumberInput
                      className="bot-bulk-clock__digits"
                      min={0}
                      max={72}
                      integer
                      value={
                        sessionPartsFromHours(
                          settings.sessionHours && settings.sessionHours > 0
                            ? settings.sessionHours
                            : 0.5,
                        ).hours
                      }
                      disabled={busy}
                      aria-label="Session hours"
                      onCommit={(hours) => {
                        setCustomClockOpen(true);
                        const mins = sessionPartsFromHours(
                          settings.sessionHours && settings.sessionHours > 0
                            ? settings.sessionHours
                            : 0.5,
                        ).minutes;
                        const nextMins = hours <= 0 && mins <= 0 ? 30 : mins;
                        onChange(
                          applyOuBulkSession(
                            settings,
                            "custom",
                            isVirtual,
                            sessionHoursFromParts(hours, nextMins),
                          ),
                        );
                      }}
                    />
                  </label>
                  <span className="bot-bulk-clock__colon" aria-hidden>
                    :
                  </span>
                  <label className="bot-bulk-clock__unit">
                    <span>Minutes</span>
                    <CleanNumberInput
                      className="bot-bulk-clock__digits"
                      min={0}
                      max={59}
                      integer
                      value={
                        sessionPartsFromHours(
                          settings.sessionHours && settings.sessionHours > 0
                            ? settings.sessionHours
                            : 0.5,
                        ).minutes
                      }
                      disabled={busy}
                      aria-label="Session minutes"
                      onCommit={(minutes) => {
                        setCustomClockOpen(true);
                        const hours = sessionPartsFromHours(
                          settings.sessionHours && settings.sessionHours > 0
                            ? settings.sessionHours
                            : 0.5,
                        ).hours;
                        const nextHours =
                          hours <= 0 && minutes <= 0 ? 0 : hours;
                        const nextMins =
                          nextHours <= 0 && minutes <= 0 ? 1 : minutes;
                        onChange(
                          applyOuBulkSession(
                            settings,
                            "custom",
                            isVirtual,
                            sessionHoursFromParts(nextHours, nextMins),
                          ),
                        );
                      }}
                    />
                  </label>
                </div>
                <em className="bot-bulk-clock__sum">
                  Runs{" "}
                  {formatSessionDuration(
                    settings.sessionHours && settings.sessionHours > 0
                      ? settings.sessionHours
                      : 0.5,
                  )}{" "}
                  · stake {settings.stake.toFixed(2)} each trade · TP ignored
                </em>
              </div>
            ) : null}
            <small className="bot-field__hint">
              Timed cards (1h / 4h / 8h / Custom) run the full wall clock at your
              set stake. Take profit does not stop the bot. Quick = stop on take
              profit. Custom opens the clock so you can type hours and minutes.
            </small>
          </div>
        ) : null}
        <div className="bot-runctl">
          <label className="bot-runctl__card">
            <span>Take profit</span>
            <div className="bot-risk__input-row">
              <CleanNumberInput
                min={0}
                step={0.01}
                value={settings.takeProfit}
                disabled={busy}
                onCommit={(takeProfit) => {
                  const timed = (settings.sessionHours ?? 0) > 0;
                  if (timed) {
                    // Comfort marker only — timed session still runs the full clock.
                    onChange({
                      ...settings,
                      takeProfit,
                      takeProfitManual: true,
                      dailyProfitTarget: 0,
                    });
                    return;
                  }
                  const ctx = payoutCtxFromSettings(settings);
                  const limits = profitLimitsForStake(
                    settings.stake,
                    settings.contracts,
                    isVirtual,
                    takeProfit,
                    ctx,
                  );
                  onChange({
                    ...settings,
                    ...limits,
                    takeProfitManual: true,
                    maxRunsManual: false,
                    sessionHours: 0,
                  });
                }}
              />
              <em>{currency}</em>
            </div>
            <small>
              {(settings.sessionHours ?? 0) > 0
                ? settings.takeProfit > 0
                  ? `Comfort only · ${formatSessionDuration(settings.sessionHours ?? 0)} timed keeps trading past +${settings.takeProfit.toFixed(2)} until the clock ends`
                  : `${formatSessionDuration(settings.sessionHours ?? 0)} timed · no TP stop · runs until clock ends`
                : settings.takeProfit > 0
                  ? settings.takeProfitManual
                    ? `Stops this Start at +${settings.takeProfit.toFixed(2)} ${currency}`
                    : isOverUnderDesk
                      ? `Auto = one ${contractName} win · stop at +${settings.takeProfit.toFixed(2)} ${currency}`
                      : `Auto from stake · stop at +${settings.takeProfit.toFixed(2)} ${currency}`
                  : "0 = off"}
            </small>
          </label>
          <label className="bot-runctl__card">
            <span>Stop loss</span>
            <div className="bot-risk__input-row">
              <CleanNumberInput
                min={0}
                step={0.01}
                value={settings.stopLoss}
                disabled={busy}
                onCommit={(stopLoss) => onChange({ ...settings, stopLoss })}
              />
              <em>{currency}</em>
            </div>
            <small>
              {settings.stopLoss > 0
                ? `Stops this Start at −${settings.stopLoss.toFixed(2)} ${currency}`
                : "0 = off"}
            </small>
          </label>
          <label className="bot-runctl__card">
            <span>Number of runs</span>
            <div className="bot-risk__input-row">
              <CleanNumberInput
                min={0}
                step={1}
                integer
                value={settings.maxRuns}
                disabled={busy}
                onCommit={(maxRuns) =>
                  onChange({
                    ...settings,
                    maxRuns,
                    maxRunsManual: true,
                    maxTradesPerDay: Math.max(
                      settings.maxTradesPerDay,
                      maxRuns + 24,
                    ),
                  })
                }
              />
              <em>trades</em>
            </div>
            <small>
              {(settings.sessionHours ?? 0) > 0
                ? `${formatSessionDuration(settings.sessionHours ?? 0)} timed · unlimited trades until the clock ends · now ${runsThisStart}`
                : settings.maxRuns > 0
                  ? `Hard cap · stop after ${settings.maxRuns} settled trades · now ${runsThisStart}/${settings.maxRuns}`
                  : `0 = unlimited trades · ${runsThisStart} this Start`}
            </small>
          </label>
        </div>
        {!isOverUnderDesk &&
        (settings.maxRuns > 0 || settings.takeProfit > 0) ? (
          <p className="bot-runctl__hint">
            {(() => {
              const ctx = payoutCtxFromSettings(settings);
              const winPnl = liveWinPnl(
                settings.stake,
                settings.contracts,
                ctx,
              );
              const winsForTp =
                settings.takeProfit > 0 && winPnl > 0
                  ? runsForTakeProfit(
                      settings.takeProfit,
                      settings.stake,
                      settings.contracts,
                      ctx,
                    )
                  : 0;
              const parts: string[] = [];
              parts.push(`One win ≈ +${winPnl.toFixed(2)} ${currency}`);
              if (settings.takeProfit > 0 && winsForTp > 0) {
                parts.push(
                  `TP +${settings.takeProfit.toFixed(2)} needs ~${winsForTp} wins`,
                );
              }
              if (settings.maxRuns > 0) {
                parts.push(`trade cap ${settings.maxRuns}`);
              }
              if (busy || runsThisStart > 0) {
                parts.push(
                  `this Start ${runsThisStart}${
                    settings.maxRuns > 0 ? `/${settings.maxRuns}` : ""
                  } · P/L ${pnlThisStart >= 0 ? "+" : ""}${pnlThisStart.toFixed(2)}`,
                );
              }
              return parts.join(" · ");
            })()}
          </p>
        ) : isOverUnderDesk && (busy || runsThisStart > 0) ? (
          <p className="bot-runctl__hint">
            This Start {runsThisStart}
            {settings.maxRuns > 0 ? `/${settings.maxRuns}` : ""} · P/L{" "}
            {pnlThisStart >= 0 ? "+" : ""}
            {pnlThisStart.toFixed(2)} {currency}
          </p>
        ) : null}
      </Section>

      <Section title="Analyzer pace">
        <p className="bot-pace__intro">
          {isMatchesSide ? (
            <>
              Matches firm hunts the best hot market, proves briefly, then buys
              same-tick. HIGH unique only.
            </>
          ) : (
            <>
              Same firm HIGH gates either way — only wait times change. Steady is
              what you have now.
            </>
          )}
        </p>
        <div className="bot-pace" role="radiogroup" aria-label="Analyzer pace">
          {paceChoices.map((pace) => {
            const active = (settings.analyzerPace ?? "steady") === pace.id;
            return (
              <button
                key={pace.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`bot-pace__option ${active ? "is-active" : ""} ${
                  pace.recommended ? "is-recommended" : ""
                }`}
                disabled={busy}
                onClick={() => {
                  const id = pace.id as AnalyzerPaceId;
                  onChange({
                    ...settings,
                    analyzerPace: id,
                    cooldownTicks: pace.cooldownTicks,
                  });
                }}
              >
                <span className="bot-pace__title">
                  {pace.label}
                  {pace.recommended ? (
                    <em className="bot-pace__badge">Recommended</em>
                  ) : null}
                </span>
                <small>{pace.blurb}</small>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Follow">
        {onRestoreDiffersFast ||
        onRestoreMatchesFirm ||
        onRestoreOverUnder ||
        onApplyLiveSettings ? (
          <div className="bot-profile-row">
            <p className="bot-profile-row__copy">
              {tradingMode === "live" && liveProfileActive ? (
                isVirtual ? (
                  <>
                    <strong>Demo live</strong> · take profit +{settings.takeProfit.toFixed(2)}{" "}
                    · {settings.maxRuns} runs · {settings.contracts}× stake{" "}
                    {settings.stake.toFixed(2)} · Stop anytime
                  </>
                ) : (
                  <>
                    <strong>Real live</strong> · {settings.maxRuns} trades / Start · cold gap
                    ≥5 · stake {settings.stake.toFixed(2)}
                  </>
                )
              ) : tradingMode === "live" ? (
                <>Live mode · apply recommended settings before Start</>
              ) : overUnderActive ? (
                <>
                  <strong>Over/Under Blitz</strong> · high-hit barriers · prove
                  ~2s · same-tick · runs ({settings.maxRuns || "∞"})
                </>
              ) : matchesFirmActive ? (
                <>
                  <strong>Matches firm</strong> · hunt best hot · short prove ·
                  same-tick · runs ({settings.maxRuns || "∞"})
                </>
              ) : differsFastActive ? (
                <>
                  <strong>Differs</strong> · Digits Good each entry · Number of
                  runs owns this Start ({settings.maxRuns || "∞"})
                </>
              ) : isOverUnderDesk ? (
                <>Custom Over/Under settings · not on O/U profile</>
              ) : isMatchesSide ? (
                <>Custom Matches settings · not on Matches firm</>
              ) : (
                <>Custom bot settings · not on the Differs profile</>
              )}
            </p>
            {tradingMode === "live" && onApplyLiveSettings ? (
              <button
                type="button"
                className="bot-link bot-link--accent"
                disabled={busy}
                onClick={onApplyLiveSettings}
              >
                {liveProfileActive ? "Refresh live settings" : "Apply live settings"}
              </button>
            ) : tradingMode !== "live" &&
              isOverUnderDesk &&
              !overUnderActive &&
              onRestoreOverUnder ? (
              <button
                type="button"
                className="bot-link"
                disabled={busy}
                onClick={onRestoreOverUnder}
              >
                Restore Over/Under profile
              </button>
            ) : tradingMode !== "live" &&
              isMatchesSide &&
              !matchesFirmActive &&
              onRestoreMatchesFirm ? (
              <button
                type="button"
                className="bot-link"
                disabled={busy}
                onClick={onRestoreMatchesFirm}
              >
                Restore Matches firm
              </button>
            ) : tradingMode !== "live" &&
              !isMatchesSide &&
              !isOverUnderDesk &&
              !differsFastActive &&
              onRestoreDiffersFast ? (
              <button
                type="button"
                className="bot-link"
                disabled={busy}
                onClick={onRestoreDiffersFast}
              >
                Restore Differs profile
              </button>
            ) : null}
          </div>
        ) : null}
        <label className="bot-switch">
          <input
            type="checkbox"
            checked={settings.autoFollow}
            onChange={(event) => onChange({ ...settings, autoFollow: event.target.checked })}
          />
          <span>
            Feed from analyzer in realtime
            <small>Tracks analyzer digit each tick.</small>
          </span>
        </label>

        <label className="bot-switch">
          <input
            type="checkbox"
            checked={settings.autoSide}
            onChange={(event) => onChange({ ...settings, autoSide: event.target.checked })}
          />
          <span>
            {isOverUnderDesk ? "Auto Over / Under" : "Auto Matches / Differs"}
            <small>Off = you pick the side with the cards above.</small>
          </span>
        </label>

        <label className="bot-field">
          <span>Auto side preference</span>
          <select
            value={settings.sidePreference}
            disabled={busy || !settings.autoSide}
            onChange={(event) =>
              onChange({
                ...settings,
                sidePreference: event.target.value as BotSettings["sidePreference"],
              })
            }
          >
            <option value="differs">Differs only · high win rate</option>
            <option value="winrate">Differs first · Matches as fallback</option>
            <option value="edge">Best edge · whichever clears break-even by more</option>
            <option value="matches">Matches only · big payout, rare hit</option>
          </select>
        </label>

        <label className="bot-switch">
          <input
            type="checkbox"
            checked={settings.parallelExecution}
            onChange={(event) =>
              onChange({ ...settings, parallelExecution: event.target.checked })
            }
          />
          <span>
            Parallel bulk execution
            <small>Fires every bulk leg on one tick. Off is slower and legs can slip.</small>
          </span>
        </label>
      </Section>

      <Section title="Stats">
        <div className="bot-stats">
          <div className="bot-stats__hero">
            <div className="bot-stats__card bot-stats__card--hero">
              <span>Win rate</span>
              <strong className={performance.edgeVsBreakEven >= 0 ? "is-up" : "is-down"}>
                {performance.winRate.toFixed(1)}%
              </strong>
            </div>
            <div className="bot-stats__card bot-stats__card--hero">
              <span>Expectancy</span>
              <strong className={performance.expectancy >= 0 ? "is-up" : "is-down"}>
                {performance.expectancy >= 0 ? "+" : ""}
                {performance.expectancy.toFixed(2)} {currency}
              </strong>
            </div>
          </div>

          <div className="bot-stats__grid">
            <div className="bot-stats__card">
              <span>vs break-even</span>
              <strong className={performance.edgeVsBreakEven >= 0 ? "is-up" : "is-down"}>
                {performance.edgeVsBreakEven >= 0 ? "+" : ""}
                {performance.edgeVsBreakEven.toFixed(1)}%
              </strong>
            </div>
            <div className="bot-stats__card">
              <span>W / L</span>
              <strong>
                {performance.wins} / {performance.losses}
              </strong>
            </div>
            <div className="bot-stats__card">
              <span>Profit factor</span>
              <strong>
                {performance.profitFactor === null ? "—" : performance.profitFactor.toFixed(2)}
              </strong>
            </div>
            <div className="bot-stats__card">
              <span>Max drawdown</span>
              <strong className="is-down">{performance.maxDrawdown.toFixed(2)}</strong>
            </div>
            <div className="bot-stats__card">
              <span>Loss rate</span>
              <strong>{performance.lossRate.toFixed(1)}%</strong>
            </div>
            <div className="bot-stats__card">
              <span>Skipped</span>
              <strong>{session.skipped}</strong>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Filters">
        <div className="bot-panel__grid">
          <label className="bot-field">
            <span>Min sample</span>
            <CleanNumberInput
              min={0}
              max={2500}
              integer
              emptyValue={0}
              value={settings.minSample}
              onCommit={(minSample) => onChange({ ...settings, minSample })}
            />
            <small>~865 ticks needed to tell a real 12% digit from 10% noise.</small>
          </label>
          <label className="bot-field">
            <span>Min edge % vs BE</span>
            <CleanNumberInput
              min={0}
              max={10}
              step={0.5}
              value={settings.minEdgePercent}
              onCommit={(minEdgePercent) => onChange({ ...settings, minEdgePercent })}
            />
          </label>
          <label className="bot-field">
            <span>Cooldown ticks</span>
            <CleanNumberInput
              min={0}
              max={20}
              integer
              value={settings.cooldownTicks}
              onCommit={(cooldownTicks) => onChange({ ...settings, cooldownTicks })}
            />
          </label>
          <label className="bot-field">
            <span>Pause after N if weak</span>
            <CleanNumberInput
              min={0}
              max={500}
              integer
              emptyValue={0}
              value={settings.pauseIfBelowBreakEvenAfter}
              onCommit={(pauseIfBelowBreakEvenAfter) =>
                onChange({ ...settings, pauseIfBelowBreakEvenAfter })
              }
            />
          </label>
          <label className="bot-field">
            <span>Pause if exp− after N</span>
            <CleanNumberInput
              min={0}
              max={500}
              integer
              emptyValue={0}
              value={settings.pauseIfExpectancyNegativeAfter}
              onCommit={(pauseIfExpectancyNegativeAfter) =>
                onChange({ ...settings, pauseIfExpectancyNegativeAfter })
              }
            />
          </label>
          <label className="bot-field">
            <span>Max drawdown %</span>
            <CleanNumberInput
              min={0}
              max={100}
              value={settings.maxDrawdownPercent}
              onCommit={(maxDrawdownPercent) =>
                onChange({ ...settings, maxDrawdownPercent })
              }
            />
          </label>
          <label className="bot-field">
            <span>Max trades / hour</span>
            <CleanNumberInput
              min={0}
              max={200}
              integer
              value={settings.maxTradesPerHour}
              onCommit={(maxTradesPerHour) =>
                onChange({ ...settings, maxTradesPerHour })
              }
            />
          </label>
        </div>

        <label className="bot-switch bot-switch--spaced">
          <input
            type="checkbox"
            checked={settings.skipLowConfidence}
            onChange={(event) =>
              onChange({ ...settings, skipLowConfidence: event.target.checked })
            }
          />
          <span>
            Skip low-confidence signals
            <small>Hold while confidence is low.</small>
          </span>
        </label>
        <label className="bot-switch bot-switch--spaced">
          <input
            type="checkbox"
            checked={settings.requireFullConfirm}
            onChange={(event) =>
              onChange({ ...settings, requireFullConfirm: event.target.checked })
            }
          />
          <span>
            Require full 5/5 confirms
            <small>
              Opens on 1.1% of ticks and never at all on some indices. No gate
              changes the win rate, so this only makes the bot wait longer.
            </small>
          </span>
        </label>
        <label className="bot-switch bot-switch--spaced">
          <input
            type="checkbox"
            checked={settings.requireMultiWindow}
            onChange={(event) =>
              onChange({ ...settings, requireMultiWindow: event.target.checked })
            }
          />
          <span>
            Require multi-window agreement
            <small>50 / 100 / 250 must agree.</small>
          </span>
        </label>
        <label className="bot-switch bot-switch--spaced">
          <input
            type="checkbox"
            checked={settings.requireWindowsEv}
            onChange={(event) =>
              onChange({ ...settings, requireWindowsEv: event.target.checked })
            }
          />
          <span>
            Require multi-window EV
            <small>Digit clears BE in all windows.</small>
          </span>
        </label>
        <label className="bot-switch bot-switch--spaced">
          <input
            type="checkbox"
            checked={settings.requireTiming}
            onChange={(event) =>
              onChange({ ...settings, requireTiming: event.target.checked })
            }
          />
          <span>
            Require timing confirm
            <small>Hot/cold gap must pass.</small>
          </span>
        </label>
        <label className="bot-switch bot-switch--spaced">
          <input
            type="checkbox"
            checked={settings.requireUneven}
            onChange={(event) =>
              onChange({ ...settings, requireUneven: event.target.checked })
            }
          />
          <span>
            Require uneven window (χ²)
            <small>
              Passes on 6.3% of ticks. The digits are uniform, so this fires on
              chance alone — it is what stalls the bot.
            </small>
          </span>
        </label>
        <div className="bot-panel__grid">
          <label className="bot-field">
            <span>Momentum max gap</span>
            <CleanNumberInput
              min={0}
              max={10}
              integer
              value={settings.maxMomentumGap}
              onCommit={(maxMomentumGap) => onChange({ ...settings, maxMomentumGap })}
            />
          </label>
          <label className="bot-field">
            <span>Cold min gap</span>
            <CleanNumberInput
              min={0}
              max={40}
              integer
              value={settings.minColdGap}
              onCommit={(minColdGap) => onChange({ ...settings, minColdGap })}
            />
          </label>
        </div>
      </Section>

      <Section title="Risk">
        <div className="bot-risk">
          <div className="bot-risk__hero">
            <div className="bot-risk__card bot-risk__card--hero">
              <span>Balance</span>
              <strong className="bot-risk__balance">
                {balance === null
                  ? "—"
                  : `${balance.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })} ${currency}`}
              </strong>
            </div>
            <div className="bot-risk__card bot-risk__card--hero">
              <span>Next exposure</span>
              <strong>
                {totalExposure.toFixed(2)} {currency}
              </strong>
            </div>
          </div>

          {/* Lives here rather than under Execution: this is the setting that
              decides the numbers in the cards above it. */}
          <label className="bot-switch bot-switch--martingale">
            <input
              type="checkbox"
              checked={settings.martingale}
              onChange={(event) =>
                onChange({ ...settings, martingale: event.target.checked })
              }
            />
            <span>
              Martingale after loss
              <small>
                {settings.martingale
                  ? "On · stake climbs until a win clears the deficit."
                  : "Off · every trade risks the same amount."}
              </small>
            </span>
            <em className={settings.martingale ? "is-on" : "is-off"}>
              {settings.martingale ? "ON" : "OFF"}
            </em>
          </label>

          {settings.martingale ? (
            <>
              <p className="bot-recovery is-warn">
                {`Recovery risk · after a ${recovery.risked.toFixed(2)} ${currency} loss the ladder puts ${recovery.plan.exposure.toFixed(2)} ${currency} on the table to win back ${recovery.risked.toFixed(2)}. It clears about ${(recovery.plan.exposure / Math.max(0.01, recovery.risked)).toFixed(0)}x the deficit each attempt, so the one rung in ten that loses costs ${recovery.plan.exposure.toFixed(2)} — roughly ${Math.ceil(recovery.plan.exposure / Math.max(0.01, recovery.risked * profitRate(settings.side))).toLocaleString()} ordinary wins to rebuild.`}
              </p>
              <div className="bot-panel__grid">
                <label className="bot-field">
                  <span>Multiplier</span>
                  <CleanNumberInput
                    min={1.1}
                    max={3}
                    step={0.1}
                    emptyValue={2}
                    value={settings.martingaleMultiplier}
                    onCommit={(martingaleMultiplier) =>
                      onChange({ ...settings, martingaleMultiplier })
                    }
                  />
                </label>
                <label className="bot-field">
                  <span>Max martingale steps</span>
                  <CleanNumberInput
                    min={1}
                    max={8}
                    integer
                    value={settings.maxMartingaleSteps}
                    onCommit={(maxMartingaleSteps) =>
                      onChange({ ...settings, maxMartingaleSteps })
                    }
                  />
                </label>
              </div>
            </>
          ) : (
            <p className="bot-recovery is-ok">
              {`Flat staking · every basket risks ${recovery.risked.toFixed(2)} ${currency}. A loss costs ${recovery.risked.toFixed(2)} and nothing escalates.`}
            </p>
          )}

          <ExposureNotice
            settings={settings}
            balance={balance}
            currency={currency}
            busy={busy}
            onChange={onChange}
          />

          <div className="bot-risk__grid">
            <div className="bot-risk__card">
              <span>Next stake</span>
              <strong>
                {nextStake.toFixed(2)} {currency}
              </strong>
            </div>
            <div className="bot-risk__card">
              <span>W / L</span>
              <strong>
                {session.wins} / {session.losses}
              </strong>
            </div>
            <label className="bot-risk__card bot-risk__card--edit">
              <span>Daily loss cap</span>
              <div className="bot-risk__input-row">
                <CleanNumberInput
                  min={0.01}
                  step={0.01}
                  value={settings.dailyLossLimit}
                  disabled={busy}
                  onCommit={(dailyLossLimit) =>
                    onChange({ ...settings, dailyLossLimit })
                  }
                />
                <em>{currency}</em>
              </div>
            </label>
            <label className="bot-risk__card bot-risk__card--edit">
              <span>Profit target</span>
              <div className="bot-risk__input-row">
                <CleanNumberInput
                  min={0.01}
                  step={0.01}
                  value={settings.dailyProfitTarget}
                  disabled={busy}
                  onCommit={(dailyProfitTarget) =>
                    onChange({ ...settings, dailyProfitTarget })
                  }
                />
                <em>{currency}</em>
              </div>
            </label>
            <label className="bot-risk__card bot-risk__card--edit">
              <span>Max losses row</span>
              <CleanNumberInput
                min={1}
                step={1}
                integer
                value={settings.maxConsecutiveLosses}
                disabled={busy}
                onCommit={(maxConsecutiveLosses) =>
                  onChange({ ...settings, maxConsecutiveLosses })
                }
              />
            </label>
            <label className="bot-risk__card bot-risk__card--edit">
              <span>Max trades / day</span>
              <CleanNumberInput
                min={1}
                step={1}
                integer
                value={settings.maxTradesPerDay}
                disabled={busy}
                onCommit={(maxTradesPerDay) =>
                  onChange({ ...settings, maxTradesPerDay })
                }
              />
            </label>
          </div>
        </div>
      </Section>

      {operatorControlled ? (
        <p className="bot-operator-lock">
          AI Operator is controlling the bot. Stop the Operator from the AI tab to
          trade manually.
        </p>
      ) : null}

      <button
        type="button"
        className={`bot-start ${busy ? "is-running" : ""}`}
        disabled={operatorControlled || (!canStart && !busy)}
        onClick={onToggle}
      >
        {operatorControlled
          ? "Locked · AI Operator"
          : settings.running
            ? settling
              ? "Stop · in trade"
              : "Stop trade"
            : scanning
              ? "Cancel · scanning markets"
              : arming
                ? `Cancel · ${countdown}s left`
                : settings.armSeconds > 0
                  ? `Start · ${settings.armSeconds}s timer`
                  : "Start trading"}
      </button>

      <Section title="Journal">
        {session.journal.length === 0 ? (
          <p className="bot-journal__empty">No closed trades yet this session.</p>
        ) : (
          <ul className="bot-journal-list">
            {session.journal.slice(0, 12).map((entry) => (
              <li key={entry.id}>
                <em className={entry.won ? "is-up" : "is-down"}>{entry.won ? "W" : "L"}</em>
                <span>
                  {sideShort(entry.side)}
                  {entry.digit} → {entry.settleDigit ?? "?"}
                </span>
                <strong className={entry.pnl >= 0 ? "is-up" : "is-down"}>
                  {entry.pnl >= 0 ? "+" : ""}
                  {entry.pnl.toFixed(2)}
                </strong>
                <small>
                  {entry.mode}
                  {entry.contractId ? ` #${entry.contractId}` : ""}
                </small>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Activity">
        <div className="bot-log">
          <ul>
            {log.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
        </div>
      </Section>
    </aside>
  );
}
