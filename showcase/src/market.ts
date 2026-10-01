export type Regime = "pattern" | "fair";

export interface Tick {
  epoch: number;
  quote: number;
  digit: number;
  /** Decimal places the quote is priced in; the last digit is taken at this precision. Defaults to 2. */
  pip?: number;
  /** Symbol the tick belongs to when several markets stream at once. */
  market?: string;
}

export type BiasKind = "cold-digit" | "hot-digit" | "high" | "low" | "even" | "odd";

export interface Bias {
  kind: BiasKind;
  digit: number;
}

/** Setting `symbol` to this lets the bot watch every index below and trade whichever has the strongest edge. */
export const AUTO_SYMBOL = "auto";

export const REAL_SYMBOLS: { id: string; name: string; short: string }[] = [
  { id: "R_10", name: "Volatility 10 Index", short: "V10" },
  { id: "R_25", name: "Volatility 25 Index", short: "V25" },
  { id: "R_50", name: "Volatility 50 Index", short: "V50" },
  { id: "R_75", name: "Volatility 75 Index", short: "V75" },
  { id: "R_100", name: "Volatility 100 Index", short: "V100" },
  { id: "1HZ10V", name: "Volatility 10 (1s) Index", short: "V10 1s" },
  { id: "1HZ25V", name: "Volatility 25 (1s) Index", short: "V25 1s" },
  { id: "1HZ50V", name: "Volatility 50 (1s) Index", short: "V50 1s" },
  { id: "1HZ75V", name: "Volatility 75 (1s) Index", short: "V75 1s" },
  { id: "1HZ100V", name: "Volatility 100 (1s) Index", short: "V100 1s" },
];

export const symbolName = (id: string) =>
  id === AUTO_SYMBOL ? "Auto · all volatility indices" : REAL_SYMBOLS.find((x) => x.id === id)?.name ?? id;
export const symbolShort = (id: string) => REAL_SYMBOLS.find((x) => x.id === id)?.short ?? id;

export const MARKET_NAME = "LLS Demo 100 Index";
export const MARKET_SYMBOL = "LLS100";

/** Ticks before the pattern market switches to a different bias. */
export const PHASE_TICKS = 500;
const VOLATILITY = 0.6;
const BIAS_KINDS: BiasKind[] = ["cold-digit", "hot-digit", "high", "low", "even", "odd"];

/** Which contracts the market's patterns should favour; mirrors the bot's strategy modes. */
export type MarketFocus = "auto" | "differs" | "matches" | "overunder" | "evenodd";

const FOCUS_KINDS: Record<MarketFocus, BiasKind[]> = {
  auto: BIAS_KINDS,
  differs: ["cold-digit"],
  matches: ["hot-digit"],
  overunder: ["high", "low"],
  evenodd: ["even", "odd"],
};

export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spread(weights: number[], fixed: Set<number>, total: number): number[] {
  const free = 10 - fixed.size;
  return weights.map((w, d) => (fixed.has(d) ? w : total / free));
}

/** Digit probabilities for each bias, tuned so each one favours a different contract. */
export function biasWeights(bias: Bias | null): number[] {
  const w = new Array<number>(10).fill(0.1);
  if (!bias) return w;
  switch (bias.kind) {
    case "cold-digit":
      w[bias.digit] = 0.04;
      return spread(w, new Set([bias.digit]), 0.96);
    case "hot-digit":
      w[bias.digit] = 0.17;
      return spread(w, new Set([bias.digit]), 0.83);
    case "high":
      w[0] = w[1] = 0.045;
      return spread(w, new Set([0, 1]), 0.91);
    case "low":
      w[8] = w[9] = 0.045;
      return spread(w, new Set([8, 9]), 0.91);
    case "even":
      return w.map((_, d) => (d % 2 === 0 ? 0.12 : 0.08));
    case "odd":
      return w.map((_, d) => (d % 2 === 1 ? 0.12 : 0.08));
  }
}

export function biasLabel(bias: Bias): string {
  switch (bias.kind) {
    case "cold-digit":
      return `Digit ${bias.digit} under-printing`;
    case "hot-digit":
      return `Digit ${bias.digit} over-printing`;
    case "high":
      return "High digits favoured";
    case "low":
      return "Low digits favoured";
    case "even":
      return "Even digits favoured";
    case "odd":
      return "Odd digits favoured";
  }
}

/**
 * Our own synthetic index. "fair" prints uniformly random last digits, like a
 * real volatility index. "pattern" rotates through hidden biases every
 * PHASE_TICKS ticks, each one giving a different contract type an edge.
 */
export class DemoMarket {
  regime: Regime;
  bias: Bias;
  focus: MarketFocus;
  private rand: () => number;
  private quote = 1000;
  private epoch = 0;
  private phaseStart = 0;

  constructor(regime: Regime, seed = Date.now(), focus: MarketFocus = "auto") {
    this.regime = regime;
    this.focus = focus;
    this.rand = mulberry32(seed);
    this.bias = this.nextBias(null);
  }

  /** Switch which contracts the patterns favour; a mismatched pattern changes immediately. */
  setFocus(focus: MarketFocus): boolean {
    if (focus === this.focus) return false;
    this.focus = focus;
    if (!FOCUS_KINDS[focus].includes(this.bias.kind)) {
      this.bias = this.nextBias(null);
      this.phaseStart = this.epoch;
    }
    return true;
  }

  next(): Tick {
    this.epoch += 1;
    if (this.epoch - this.phaseStart >= PHASE_TICKS) {
      this.bias = this.nextBias(this.bias);
      this.phaseStart = this.epoch;
    }

    const weights = biasWeights(this.regime === "pattern" ? this.bias : null);
    let r = this.rand();
    let digit = 9;
    for (let d = 0; d < 10; d++) {
      r -= weights[d];
      if (r < 0) {
        digit = d;
        break;
      }
    }

    const moved = this.quote + this.gaussian() * VOLATILITY;
    const tenths = Math.floor(Math.max(10, moved) * 10) / 10;
    this.quote = Math.round((tenths + digit / 100) * 100) / 100;
    return { epoch: this.epoch, quote: this.quote, digit };
  }

  private nextBias(prev: Bias | null): Bias {
    const allowed = FOCUS_KINDS[this.focus];
    const kinds = prev && allowed.length > 1 ? allowed.filter((k) => k !== prev.kind) : allowed;
    let digit = Math.floor(this.rand() * 10);
    if (prev && kinds.length === 1 && kinds[0] === prev.kind && digit === prev.digit) digit = (digit + 1 + Math.floor(this.rand() * 9)) % 10;
    return { kind: kinds[Math.floor(this.rand() * kinds.length)], digit };
  }

  private gaussian(): number {
    const u = Math.max(this.rand(), 1e-12);
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
