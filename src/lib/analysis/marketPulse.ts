import { resolveAnalyzerPace, type AnalyzerPaceId } from "./analyzerPace";
import { isAnalyzerGood } from "./analyzerGate";
import type { DigitStats } from "./digits";
import { isOverUnderSide, sideLabel } from "./contractSide";
import { isArmedSignal, type ContractSide, type MarketSignal } from "./signal";

export type MarketMood = "loading" | "good" | "watch" | "bounce" | "flat" | "bad";

export interface PulseRequirements {
  /** Differs cold-gap floor the bot needs before timing clears. */
  minColdGap: number;
  /** Sample size floor for high/armed. */
  minSample: number;
  maxMomentumGap?: number;
  side?: ContractSide;
  /** Short market label, e.g. "V75". */
  volatilityLabel?: string;
  /** Analyzer pace — Steady / Safer+fast / Matches firm / OverUnder. */
  analyzerPace?: AnalyzerPaceId;
  /** OU momentum mode — entries fire on tape momentum, not statistical proof. */
  momentumMode?: boolean;
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
  const pace = resolveAnalyzerPace(req.analyzerPace);
  const lockSec = Math.round(pace.lockMs / 1000);
  const coolSec = Math.round(pace.lossCoolMs / 1000);
  if (
    (req.side && isOverUnderSide(req.side)) ||
    req.analyzerPace === "overunder-firm"
  ) {
    const mom = req.maxMomentumGap ?? 3;
    return `BLITZ · edge vs fair · payout EV · µ12/s36 · gap≤${mom} · ${pace.shortLabel} · lock~${lockSec}s · cool ${coolSec}s · same-tick buy${vol}`;
  }
  if (req.side === "DIGITMATCH" || req.analyzerPace === "matches-firm") {
    const mom = req.maxMomentumGap ?? 1;
    return `HIGH · unique hot · gap≤${mom} · ${pace.shortLabel} · lock~${lockSec}s · cool ${coolSec}s after loss · same-tick buy${vol}`;
  }
  return `HIGH · solo/unique · gap≥${req.minColdGap}+2 · ${pace.shortLabel} · lock~${lockSec}s · cool ${coolSec}s after loss · same-tick buy${vol}`;
}

/**
 * Live desk mood — must match what the bot can actually fire.
 */
export function readMarketPulse(
  stats: DigitStats,
  signal?: MarketSignal | null,
  requirements?: PulseRequirements,
): MarketPulse {
  const minGap = requirements?.minColdGap ?? 6;
  const minSample = requirements?.minSample ?? 500;
  const maxMom = requirements?.maxMomentumGap ?? 2;
  const deskSide = requirements?.side ?? signal?.side ?? "DIGITDIFF";
  const need = formatPulseNeed(
    requirements ?? { minColdGap: minGap, minSample, side: deskSide },
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
  const hotGap = gaps[hot];
  const countLead = (counts[rival] ?? 0) - (counts[cold] ?? 0);
  const hotLead = (counts[hot] ?? 0) - (counts[hottest[1]] ?? 0);
  const marginPp = rivalPct - coldPct;
  const spread = hotPct - coldPct;

  const deskSettings = {
    minColdGap: minGap,
    minSample,
    maxMomentumGap: maxMom,
    side: deskSide,
  };

  // ── Over/Under Blitz desk ────────────────────────────────────────────
  if (isOverUnderSide(deskSide)) {
    const ou =
      signal && isOverUnderSide(signal.side) ? signal : null;
    const signalGap = ou?.watching.signalGap ?? null;
    const n = ou?.watching.sampleSize ?? sampleSize;
    const deskGood = !!ou && isAnalyzerGood(ou, deskSettings);

    if (sampleSize < 12 && (!ou || n < 12)) {
      return withNeed(
        "loading",
        "Loading",
        `Blitz collecting ticks (${sampleSize}/12 micro)`,
      );
    }

    if (ou && deskGood) {
      return withNeed(
        "good",
        isArmedSignal(ou) ? "Trade now" : "Good market",
        `${sideLabel(ou.side)} ${ou.digit} · ${ou.watching.wilsonBound} · gap ${signalGap ?? "—"}/≤${maxMom} · p${ou.power}`,
      );
    }

    // Proven-only mode: nothing is tradable until a barrier's lower bound
    // clears its payout break-even — say that plainly. Momentum mode skips
    // this and shows the live hunting states instead.
    if (ou && ou.proven !== true && requirements?.momentumMode !== true) {
      return withNeed(
        "flat",
        "No edge",
        `Every barrier pays under its risk — buying now loses on average · best ${sideLabel(ou.side)} ${ou.digit} · ${ou.watching.wilsonBound}`,
      );
    }

    if (
      ou &&
      ou.evOk &&
      ou.barrierAligned &&
      (signalGap ?? 99) <= maxMom + 1
    ) {
      return withNeed(
        "watch",
        ou.timingOk ? "Building" : "Almost",
        `${sideLabel(ou.side)} ${ou.digit} · ${ou.watching.wilsonBound} · ${ou.watching.windowEv}`,
      );
    }

    if (ou && ou.timingOk && ou.barrierAligned) {
      return withNeed(
        "watch",
        "Building",
        `${sideLabel(ou.side)} ${ou.digit} · ${ou.watching.wilsonBound} · power ${ou.power}`,
      );
    }

    if (currentStreak.length >= 5) {
      return withNeed(
        "bounce",
        "Sticky",
        `${currentStreak.digit}×${currentStreak.length} · wait for the streak to break`,
      );
    }

    return withNeed(
      "flat",
      "Hunting",
      ou
        ? `${sideLabel(ou.side)} ${ou.digit} · ${ou.watching.wilsonBound} · ${ou.watching.separation}`
        : "Blitz scanning Over 0–3 / Under 6–9 · edge vs fair",
    );
  }

  // ── Matches desk ─────────────────────────────────────────────────────
  if (deskSide === "DIGITMATCH") {
    const matches =
      signal && signal.side === "DIGITMATCH" ? signal : null;
    const signalGap = matches?.watching.signalGap ?? hotGap;
    const deskGood = !!matches && isAnalyzerGood(matches, deskSettings);

    if (matches && deskGood) {
      return withNeed(
        "good",
        isArmedSignal(matches) ? "Trade now" : "Good market",
        `Matches ${matches.digit} · gap ${signalGap ?? "—"}/≤${maxMom} · ${matches.digitPercent.toFixed(1)}% · power ${matches.power}`,
      );
    }

    if (
      matches &&
      matches.evOk &&
      matches.barrierAligned &&
      matches.primaryBarrier &&
      matches.digitPercent >= 11.0 &&
      (signalGap ?? 99) <= maxMom + 1 &&
      (!matches.uniqueEvOk || matches.power < 75 || matches.confidence !== "high")
    ) {
      return withNeed(
        "watch",
        "Almost",
        `Matches ${matches.digit} · firming · ${matches.digitPercent.toFixed(1)}% · gap ${signalGap ?? "—"} · p${matches.power}`,
      );
    }

    if (
      matches &&
      matches.timingOk &&
      matches.barrierAligned &&
      matches.primaryBarrier
    ) {
      return withNeed(
        "watch",
        "Building",
        `Matches ${matches.digit} · gap ${signalGap ?? "—"}/≤${maxMom} · power ${matches.power}`,
      );
    }

    if (hotGap !== null && hotGap <= maxMom + 1 && hotPct >= 11.0 && hotLead >= 1) {
      return withNeed(
        "watch",
        "Building",
        `Hot ${hot} · ${hotPct.toFixed(1)}% · gap ${hotGap}/≤${maxMom} · lead ${hotLead}`,
      );
    }

    if (currentStreak.length >= 5) {
      return withNeed(
        "bounce",
        "Sticky",
        `${currentStreak.digit}×${currentStreak.length} · wait for the streak to break`,
      );
    }

    if (!uniformity.significant && spread < 2.2) {
      return withNeed(
        "flat",
        "Flat",
        `Near fair 10% · hot ${hot} @ ${hotPct.toFixed(1)}% · gap ${hotGap ?? "—"}`,
      );
    }

    if (uniformity.significant && hotLead <= 0) {
      return withNeed("bad", "Messy", "Skewed window · no clear hot · stay out");
    }

    return withNeed(
      "flat",
      "Quiet",
      `Hot ${hot} @ ${hotPct.toFixed(1)}% · gap ${hotGap ?? "—"}/≤${maxMom}`,
    );
  }

  // ── Differs desk ─────────────────────────────────────────────────────
  const signalGap = signal?.watching.signalGap ?? coldGap;
  const signalDigit = signal?.digit ?? cold;
  const differs =
    !signal || signal.side === "DIGITDIFF" ? signal : null;

  const deskGood = !!differs && isAnalyzerGood(differs, deskSettings);

  if (differs && deskGood) {
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
    differs.primaryBarrier &&
    (signalGap ?? 0) >= minGap &&
    differs.digitPercent <= 9.5 &&
    (!differs.windowsAgree || !differs.separationOk || !differs.coldMarginOk)
  ) {
    const firming = !differs.windowsAgree
      ? `windows ${differs.watching.windowVotes || "—"}`
      : `lead ${differs.watching.separation || "—"}`;
    return withNeed(
      "watch",
      "Almost",
      `Differs ${differs.digit} · firming · ${firming}`,
    );
  }

  if (
    differs &&
    differs.evOk &&
    differs.timingOk &&
    differs.barrierAligned &&
    differs.primaryBarrier &&
    (signalGap ?? 0) >= Math.max(3, minGap - 2) &&
    (signalGap ?? 0) < minGap
  ) {
    return withNeed(
      "watch",
      "Almost",
      `Differs ${differs.digit} · gap ${signalGap}/${minGap} · ${differs.digitPercent.toFixed(1)}% · EV ok`,
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
      `Differs ${differs.digit} · gap ${signalGap}/${minGap} · power ${differs.power}`,
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
