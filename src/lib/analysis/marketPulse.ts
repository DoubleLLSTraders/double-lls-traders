import type { DigitStats } from "./digits";
import { isArmedSignal, type MarketSignal } from "./signal";

export type MarketMood = "loading" | "good" | "watch" | "bounce" | "flat" | "bad";

export interface PulseRequirements {
  /** Differs cold-gap floor the bot needs before timing clears. */
  minColdGap: number;
  /** Sample size floor for high/armed. */
  minSample: number;
  /** Short market label, e.g. "V75". */
  volatilityLabel?: string;
}

export interface MarketPulse {
  mood: MarketMood;
  label: string;
  detail: string;
  /** What “good / Trade now” requires — shown under the mood strip. */
  need: string;
}

export function formatPulseNeed(req: PulseRequirements): string {
  const vol = req.volatilityLabel ? ` · ${req.volatilityLabel}` : "";
  return `Good needs gap≥${req.minColdGap} · n≥${req.minSample}${vol}`;
}

/**
 * Live desk mood — must match what the bot can actually fire.
 * "Good / Trade now" only when the Differs signal is armed or fully confirmed;
 * soft gap-only reads stay on Watch so the panel does not lie about readiness.
 */
export function readMarketPulse(
  stats: DigitStats,
  signal?: MarketSignal | null,
  requirements?: PulseRequirements,
): MarketPulse {
  const minGap = requirements?.minColdGap ?? 6;
  const minSample = requirements?.minSample ?? 500;
  const need = formatPulseNeed(
    requirements ?? { minColdGap: minGap, minSample },
  );
  const withNeed = (
    mood: MarketMood,
    label: string,
    detail: string,
  ): MarketPulse => ({ mood, label, detail, need });

  const {
    sampleSize,
    percentages,
    counts,
    gaps,
    coldest,
    hottest,
    uniformity,
    currentStreak,
  } = stats;

  if (sampleSize < 50) {
    return withNeed("loading", "Loading", `Collecting ticks (${sampleSize}/50)`);
  }

  const cold = coldest[0];
  const rival = coldest[1];
  const hot = hottest[0];
  const coldPct = percentages[cold] ?? 10;
  const rivalPct = percentages[rival] ?? 10;
  const hotPct = percentages[hot] ?? 10;
  const coldGap = gaps[cold];
  const countLead = (counts[rival] ?? 0) - (counts[cold] ?? 0);
  const marginPp = rivalPct - coldPct;
  const spread = hotPct - coldPct;

  const signalGap = signal?.watching.signalGap ?? coldGap;
  const signalDigit = signal?.digit ?? cold;
  const differs =
    !signal || signal.side === "DIGITDIFF" ? signal : null;

  const deskGood =
    !!differs &&
    differs.evOk &&
    differs.timingOk &&
    differs.barrierAligned &&
    differs.primaryBarrier &&
    differs.coldMarginOk &&
    sampleSize >= minSample &&
    (signalGap ?? 0) >= minGap;

  // ── Ready when the desk bot can fire ─────────────────────────────────

  if (differs && (isArmedSignal(differs) || deskGood)) {
    return withNeed(
      "good",
      isArmedSignal(differs) ? "Trade now" : "Good market",
      `Differs ${differs.digit} · gap ${signalGap ?? "—"}/${minGap} · ${differs.digitPercent.toFixed(1)}% · power ${differs.power}`,
    );
  }

  if (
    differs &&
    differs.evOk &&
    differs.timingOk &&
    differs.barrierAligned &&
    (signalGap ?? 0) >= Math.max(3, minGap - 2)
  ) {
    return withNeed(
      "watch",
      "Almost",
      `Differs ${differs.digit} · gap ${signalGap}/${minGap} · ${differs.confidence} · power ${differs.power}`,
    );
  }

  if (
    differs &&
    differs.timingOk &&
    differs.barrierAligned &&
    (signalGap ?? 0) >= 4
  ) {
    return withNeed(
      "watch",
      "Building",
      `Differs ${differs.digit} · gap ${signalGap} · ${differs.confidence} · power ${differs.power} · waiting EV/confirms`,
    );
  }

  if (
    coldGap !== null &&
    coldGap >= 5 &&
    countLead >= 1 &&
    coldPct <= 9.5 &&
    sampleSize >= 100
  ) {
    return withNeed(
      "watch",
      "Building",
      `Cold ${cold} · ${coldPct.toFixed(1)}% · gap ${coldGap}/${minGap} · lead ${countLead}`,
    );
  }

  // ── Bounce / reset ───────────────────────────────────────────────────

  if (coldGap === 0) {
    return withNeed(
      "bounce",
      "Resetting",
      `Cold ${cold} just printed · need gap≥${minGap}`,
    );
  }

  if (currentStreak.length >= 5) {
    return withNeed(
      "bounce",
      "Sticky",
      `${currentStreak.digit}×${currentStreak.length} · wait for the streak to break`,
    );
  }

  if (countLead === 0 && coldGap !== null && coldGap < 3 && sampleSize >= 100) {
    return withNeed(
      "bounce",
      "Bouncing",
      `Cold tie ${cold}/${rival} · gap ${coldGap} · wait for a leader`,
    );
  }

  // ── Building / watch ─────────────────────────────────────────────────

  if (coldGap !== null && coldGap >= 3 && coldGap < minGap && countLead >= 1) {
    return withNeed(
      "watch",
      "Building",
      `Cold ${cold} gap ${coldGap}/${minGap} · ${coldPct.toFixed(1)}%`,
    );
  }

  if (coldGap !== null && coldGap < 3) {
    return withNeed(
      "watch",
      "Warming",
      `Cold ${cold} gap ${coldGap}/${minGap} · need ${minGap - coldGap} more away`,
    );
  }

  if (differs && differs.timingOk === false && (signalGap ?? 0) < minGap) {
    return withNeed(
      "watch",
      "Wait",
      `Gap ${signalGap ?? "—"}/${minGap} on ${signalDigit} · holding for cold`,
    );
  }

  if (!uniformity.significant && spread < 2.2) {
    return withNeed(
      "flat",
      "Flat",
      `Near fair 10% · cold ${cold} @ ${coldPct.toFixed(1)}% · gap ${coldGap ?? "—"}/${minGap}`,
    );
  }

  if (uniformity.significant && countLead <= 0 && marginPp < 0.4) {
    return withNeed("bad", "Messy", "Skewed window · no clear cold · stay out");
  }

  if (countLead >= 1 && coldGap !== null && coldGap >= 3) {
    return withNeed(
      "watch",
      "Building",
      `Cold ${cold} · gap ${coldGap}/${minGap} · lead ${countLead}`,
    );
  }

  return withNeed(
    "flat",
    "Quiet",
    `Cold ${cold} @ ${coldPct.toFixed(1)}% · gap ${coldGap ?? "—"}/${minGap}`,
  );
}
