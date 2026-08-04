/**
 * Session research for Atlas market selection.
 *
 * Sources (industry consensus):
 * - London–New York overlap ≈ 13:00–17:00 UTC is the highest FX volume window
 *   (often ~40–50%+ of daily turnover compressed into ~4 hours).
 * - EUR/USD, GBP/USD, USD/JPY see peak liquidity / tightest spreads then.
 * - EAT (East Africa Time, UTC+3): that overlap is 16:00–20:00 EAT.
 * - User desk preference: 15:00–19:00 EAT — treated as a primary trading window
 *   (covers late London into the start of the NY overlap).
 */

export type AtlasSessionId =
  | "asia"
  | "london"
  | "londonNyOverlap"
  | "newYork"
  | "off";

export interface AtlasSessionSnapshot {
  /** UTC hour 0–23 */
  utcHour: number;
  /** East Africa Time hour 0–23 (UTC+3) */
  eatHour: number;
  session: AtlasSessionId;
  /** True during user-preferred 15:00–19:00 EAT desk hours. */
  inEatPrime: boolean;
  /** True during researched London–NY overlap 13:00–17:00 UTC. */
  inLondonNyOverlap: boolean;
  /** Combined: best window for major FX accuracy / liquidity. */
  inPrimeFx: boolean;
  label: string;
  eatLabel: string;
  tip: string;
}

/** Pair / class preference during each session (higher = better home session). */
const SESSION_PAIR_WEIGHT: Record<
  AtlasSessionId,
  Record<string, number>
> = {
  asia: {
    frxUSDJPY: 90,
    frxAUDUSD: 100,
    frxXAUUSD: 40,
    frxEURUSD: 25,
    frxGBPUSD: 20,
    cryBTCUSD: 55,
    cryETHUSD: 55,
  },
  london: {
    frxEURUSD: 95,
    frxGBPUSD: 100,
    frxXAUUSD: 70,
    frxUSDJPY: 55,
    frxAUDUSD: 35,
    cryBTCUSD: 40,
    cryETHUSD: 40,
  },
  londonNyOverlap: {
    frxEURUSD: 120,
    frxGBPUSD: 110,
    frxUSDJPY: 95,
    frxXAUUSD: 85,
    frxAUDUSD: 45,
    cryBTCUSD: 50,
    cryETHUSD: 50,
  },
  newYork: {
    frxEURUSD: 80,
    frxGBPUSD: 75,
    frxUSDJPY: 70,
    frxXAUUSD: 75,
    frxAUDUSD: 40,
    cryBTCUSD: 60,
    cryETHUSD: 60,
  },
  off: {
    frxEURUSD: 20,
    frxGBPUSD: 20,
    frxUSDJPY: 25,
    frxXAUUSD: 30,
    frxAUDUSD: 30,
    cryBTCUSD: 45,
    cryETHUSD: 45,
  },
};

function utcParts(now = Date.now()): { hour: number; day: number } {
  const d = new Date(now);
  return { hour: d.getUTCHours(), day: d.getUTCDay() }; // 0=Sun
}

function eatHourFromUtc(utcHour: number): number {
  return (utcHour + 3) % 24;
}

function resolveSession(utcHour: number): AtlasSessionId {
  // London–NY overlap (research): 13:00–17:00 UTC
  if (utcHour >= 13 && utcHour < 17) return "londonNyOverlap";
  // London open before NY: 08:00–13:00 UTC
  if (utcHour >= 8 && utcHour < 13) return "london";
  // New York after London close: 17:00–22:00 UTC
  if (utcHour >= 17 && utcHour < 22) return "newYork";
  // Asia / Sydney–Tokyo stretch
  if (utcHour >= 22 || utcHour < 8) return "asia";
  return "off";
}

export function getAtlasSession(now = Date.now()): AtlasSessionSnapshot {
  const { hour: utcHour, day } = utcParts(now);
  const eat = eatHourFromUtc(utcHour);
  const weekend = day === 0 || day === 6;
  const session = weekend ? "off" : resolveSession(utcHour);
  // User desk: 15:00–19:00 EAT
  const inEatPrime = !weekend && eat >= 15 && eat < 19;
  const inLondonNyOverlap = !weekend && utcHour >= 13 && utcHour < 17;
  // Prime FX = researched overlap OR user EAT window (12:00–16:00 UTC ≈ 15–19 EAT)
  const inUserUtc = !weekend && utcHour >= 12 && utcHour < 16;
  const inPrimeFx = inLondonNyOverlap || inUserUtc || inEatPrime;

  let label: string;
  let eatLabel: string;
  let tip: string;
  if (weekend) {
    label = "Weekend · FX thin";
    eatLabel = "Weekend (EAT)";
    tip = "Major FX liquidity is thin on weekends — prefer wait or crypto only.";
  } else if (inLondonNyOverlap) {
    label = "London–NY overlap · peak FX";
    eatLabel = "16:00–20:00 EAT · peak EUR/USD liquidity";
    tip =
      "Highest daily FX volume. EUR/USD · GBP/USD · USD/JPY preferred. Tightest spreads.";
  } else if (inEatPrime) {
    label = "EAT prime desk · London→NY";
    eatLabel = "15:00–19:00 EAT · your preferred window";
    tip =
      "Your desk hours. Liquidity building into / through the London–NY overlap for EUR majors.";
  } else if (session === "london") {
    label = "London session";
    eatLabel = "11:00–16:00 EAT · London active";
    tip = "Strong for EUR/GBP. Overlap with NY starts 16:00 EAT.";
  } else if (session === "newYork") {
    label = "New York session";
    eatLabel = "20:00–01:00 EAT · NY active";
    tip = "Post-overlap — still tradeable, but volume usually cooler than 16–20 EAT.";
  } else if (session === "asia") {
    label = "Asia session";
    eatLabel = "Asia hours (EAT)";
    tip = "Better for AUD/USD · USD/JPY. EUR/USD often quieter / wider.";
  } else {
    label = "Off-peak";
    eatLabel = "Off-peak (EAT)";
    tip = "Lower liquidity — scanner will demand higher quality or skip.";
  }

  return {
    utcHour,
    eatHour: eat,
    session,
    inEatPrime,
    inLondonNyOverlap,
    inPrimeFx,
    label,
    eatLabel,
    tip,
  };
}

/**
 * Score boost/penalty for picking this symbol right now.
 * Positive = home-session / researched peak. Negative = wrong session for the pair.
 */
export function sessionFitBonus(
  symbol: string,
  assetClass: string,
  now = Date.now(),
): { bonus: number; label: string } {
  const snap = getAtlasSession(now);
  if (snap.session === "off" && assetClass === "forex") {
    return { bonus: -220, label: "weekend / off · FX skip bias" };
  }

  const table = SESSION_PAIR_WEIGHT[snap.session];
  const base = table[symbol] ?? (assetClass === "crypto" ? 45 : 30);

  let bonus = (base - 60) * 3.2; // center ~60 → 0
  let label = `${snap.label}`;

  if (snap.inLondonNyOverlap) {
    if (symbol === "frxEURUSD" || symbol === "frxGBPUSD") {
      bonus += 180;
      label = "peak overlap · EUR/GBP home";
    } else if (symbol === "frxUSDJPY" || symbol === "frxXAUUSD") {
      bonus += 110;
      label = "peak overlap · liquid";
    } else if (assetClass === "crypto") {
      bonus -= 400;
      label = "peak overlap · crypto blocked";
    }
  } else if (snap.inEatPrime || snap.inPrimeFx) {
    if (symbol === "frxEURUSD" || symbol === "frxGBPUSD") {
      bonus += 120;
      label = "EAT prime · EUR majors preferred";
    } else if (assetClass === "forex" || assetClass === "metal") {
      bonus += 50;
      label = "EAT prime · FX/metal ok";
    } else if (assetClass === "crypto") {
      bonus -= 350;
      label = "EAT prime · crypto blocked";
    }
  } else if (snap.session === "asia") {
    if (symbol === "frxEURUSD" || symbol === "frxGBPUSD") {
      bonus -= 120;
      label = "Asia hours · EUR quieter";
    } else if (symbol === "frxAUDUSD" || symbol === "frxUSDJPY") {
      bonus += 90;
      label = "Asia hours · AUD/JPY home";
    }
  } else if (!snap.inPrimeFx && assetClass === "forex") {
    bonus -= 70;
    label = "off-peak FX · quality bar raised";
  }

  return { bonus: Math.round(bonus), label };
}

/** Hard gate: during Asia / deep off-peak, don't auto-lock weak EUR.
 * During prime FX hours, never auto-lock crypto — use EUR/GBP majors.
 */
export function sessionAllowsAutoLock(
  symbol: string,
  assetClass: string,
  now = Date.now(),
): boolean {
  const snap = getAtlasSession(now);
  if (snap.session === "off" && assetClass === "forex") return false;
  // Research rule: London–NY / EAT prime = FX majors only (no ETH/BTC auto).
  if (snap.inPrimeFx && assetClass === "crypto") return false;
  if (
    snap.session === "asia" &&
    (symbol === "frxEURUSD" || symbol === "frxGBPUSD") &&
    !snap.inPrimeFx
  ) {
    return false;
  }
  return true;
}
