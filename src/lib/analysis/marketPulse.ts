import type { DigitStats } from "./digits";
import type { MarketSignal } from "./signal";

export type MarketMood = "loading" | "good" | "watch" | "bounce" | "flat" | "bad";

export interface MarketPulse {
  mood: MarketMood;
  label: string;
  detail: string;
}

/**
 * Live desk mood — actionable Differs readiness, updated every tick.
 * Prefers "Trade now" / "Good market" when a cold barrier is usable;
 * "Bouncing" only when the tape is truly flipping.
 */
export function readMarketPulse(
  stats: DigitStats,
  signal?: MarketSignal | null,
): MarketPulse {
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
    return {
      mood: "loading",
      label: "Loading",
      detail: `Collecting ticks (${sampleSize}/50)`,
    };
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
    !signal || signal.side === "DIGITDIFF"
      ? signal
      : null;

  // ── Trade now / Good first (so it is not drowned by bounce) ──────────

  if (
    differs &&
    (differs.confidence === "high" || differs.power >= 80) &&
    differs.timingOk &&
    differs.barrierAligned
  ) {
    return {
      mood: "good",
      label: "Trade now",
      detail: `Differs ${differs.digit} · gap ${signalGap ?? "—"} · ${differs.digitPercent.toFixed(1)}% · power ${differs.power}`,
    };
  }

  if (
    differs &&
    differs.timingOk &&
    differs.primaryBarrier &&
    differs.evOk &&
    (signalGap ?? 0) >= 4
  ) {
    return {
      mood: "good",
      label: "Good market",
      detail: `Cold ${differs.digit} ready · gap ${signalGap} · ${differs.digitPercent.toFixed(1)}%`,
    };
  }

  if (
    differs &&
    differs.timingOk &&
    differs.barrierAligned &&
    (signalGap ?? 0) >= 4
  ) {
    return {
      mood: "good",
      label: "Good · ready",
      detail: `Differs ${differs.digit} · gap ${signalGap} · ${differs.confidence} · power ${differs.power}`,
    };
  }

  // Practical window read — usable cold even if % lead is tiny.
  if (
    coldGap !== null &&
    coldGap >= 5 &&
    countLead >= 1 &&
    coldPct <= 9.5 &&
    sampleSize >= 100
  ) {
    return {
      mood: "good",
      label: "Good market",
      detail: `Cold ${cold} · ${coldPct.toFixed(1)}% · gap ${coldGap} · lead ${countLead} ticks`,
    };
  }

  if (coldGap !== null && coldGap >= 8 && coldPct <= 9.2 && sampleSize >= 150) {
    return {
      mood: "good",
      label: "Trade now",
      detail: `Cold ${cold} deep absence · gap ${coldGap} · ${coldPct.toFixed(1)}%`,
    };
  }

  // ── Real bounce / reset (narrow) ─────────────────────────────────────

  if (coldGap === 0) {
    return {
      mood: "bounce",
      label: "Resetting",
      detail: `Cold ${cold} just printed · wait for gap`,
    };
  }

  if (currentStreak.length >= 5) {
    return {
      mood: "bounce",
      label: "Sticky",
      detail: `${currentStreak.digit}×${currentStreak.length} · wait for the streak to break`,
    };
  }

  // True race: same count AND short gap — otherwise call it flat/watch.
  if (countLead === 0 && coldGap !== null && coldGap < 3 && sampleSize >= 100) {
    return {
      mood: "bounce",
      label: "Bouncing",
      detail: `Cold tie ${cold}/${rival} · gap ${coldGap} · wait for a leader`,
    };
  }

  // ── Building / watch ─────────────────────────────────────────────────

  if (coldGap !== null && coldGap >= 3 && coldGap < 5 && countLead >= 1) {
    return {
      mood: "watch",
      label: "Building",
      detail: `Cold ${cold} forming · gap ${coldGap} · ${coldPct.toFixed(1)}%`,
    };
  }

  if (coldGap !== null && coldGap < 3) {
    return {
      mood: "watch",
      label: "Warming",
      detail: `Cold ${cold} gap ${coldGap} · need a few more ticks away`,
    };
  }

  if (differs && differs.timingOk === false && (signalGap ?? 0) < 4) {
    return {
      mood: "watch",
      label: "Wait",
      detail: `Gap ${signalGap ?? "—"} on ${signalDigit} · holding for cold`,
    };
  }

  if (!uniformity.significant && spread < 2.2) {
    return {
      mood: "flat",
      label: "Flat",
      detail: `Near fair 10% · cold ${cold} @ ${coldPct.toFixed(1)}% · gap ${coldGap ?? "—"}`,
    };
  }

  if (uniformity.significant && countLead <= 0 && marginPp < 0.4) {
    return {
      mood: "bad",
      label: "Messy",
      detail: "Skewed window · no clear cold · stay out",
    };
  }

  if (countLead >= 1 && coldGap !== null && coldGap >= 3) {
    return {
      mood: "watch",
      label: "Building",
      detail: `Cold ${cold} · gap ${coldGap} · lead ${countLead} · almost there`,
    };
  }

  return {
    mood: "flat",
    label: "Quiet",
    detail: `Cold ${cold} @ ${coldPct.toFixed(1)}% · gap ${coldGap ?? "—"} · watching`,
  };
}
