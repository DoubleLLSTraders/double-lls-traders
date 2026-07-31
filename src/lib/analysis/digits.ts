export const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const DIGIT_COUNT = DIGITS.length;

export interface Streak {
  digit: number | null;
  length: number;
}

export interface UniformityTest {
  statistic: number;
  degreesOfFreedom: number;
  /** Probability of a deviation this large arising from a fair 10% process. */
  pValue: number;
  /** True only when the deviation is too large to comfortably call luck. */
  significant: boolean;
}

export interface DigitStats {
  sampleSize: number;
  counts: number[];
  percentages: number[];
  hottest: number[];
  coldest: number[];
  /** Ticks since each digit last appeared; null if absent from the window. */
  gaps: (number | null)[];
  currentStreak: Streak;
  evenCount: number;
  oddCount: number;
  uniformity: UniformityTest;
}

const SIGNIFICANCE_LEVEL = 0.05;

export function digitCounts(digits: number[]): number[] {
  const counts = new Array<number>(DIGIT_COUNT).fill(0);
  for (const digit of digits) {
    if (digit >= 0 && digit < DIGIT_COUNT) counts[digit] += 1;
  }
  return counts;
}

/** Ticks since each digit was last seen. 0 means it was the most recent tick. */
export function gapsSinceLastSeen(digits: number[]): (number | null)[] {
  const gaps = new Array<number | null>(DIGIT_COUNT).fill(null);
  for (let offset = 0; offset < digits.length; offset += 1) {
    const digit = digits[digits.length - 1 - offset];
    if (gaps[digit] === null) gaps[digit] = offset;
  }
  return gaps;
}

export function currentStreak(digits: number[]): Streak {
  if (digits.length === 0) return { digit: null, length: 0 };

  const digit = digits[digits.length - 1];
  let length = 1;
  for (let i = digits.length - 2; i >= 0 && digits[i] === digit; i -= 1) length += 1;
  return { digit, length };
}

/**
 * Pearson chi-square goodness-of-fit against a uniform 10% distribution.
 *
 * This is the guard against reading meaning into noise: with 1000 ticks a fair
 * generator still produces digit counts ranging roughly 75-125, which looks
 * dramatic on a bar chart but is entirely expected.
 */
export function uniformityTest(counts: number[]): UniformityTest {
  const sampleSize = counts.reduce((total, count) => total + count, 0);
  const degreesOfFreedom = DIGIT_COUNT - 1;

  if (sampleSize === 0) {
    return { statistic: 0, degreesOfFreedom, pValue: 1, significant: false };
  }

  const expected = sampleSize / DIGIT_COUNT;
  let statistic = 0;
  for (const count of counts) {
    const deviation = count - expected;
    statistic += (deviation * deviation) / expected;
  }

  const pValue = chiSquareSurvival(statistic, degreesOfFreedom);
  return {
    statistic,
    degreesOfFreedom,
    pValue,
    significant: pValue < SIGNIFICANCE_LEVEL,
  };
}

export function summarise(digits: number[]): DigitStats {
  const counts = digitCounts(digits);
  const sampleSize = digits.length;
  const percentages = counts.map((count) => (sampleSize === 0 ? 0 : (count / sampleSize) * 100));

  const ranked = [...DIGITS].sort((a, b) => counts[b] - counts[a]);
  let evenCount = 0;
  for (const digit of digits) {
    if (digit % 2 === 0) evenCount += 1;
  }

  return {
    sampleSize,
    counts,
    percentages,
    hottest: ranked.slice(0, 3),
    coldest: ranked.slice(-3).reverse(),
    gaps: gapsSinceLastSeen(digits),
    currentStreak: currentStreak(digits),
    evenCount,
    oddCount: sampleSize - evenCount,
    uniformity: uniformityTest(counts),
  };
}

// --- Chi-square distribution ------------------------------------------------
// Survival function via the regularised upper incomplete gamma function
// Q(k/2, x/2), using a series expansion below the transition point and a
// continued fraction above it (Numerical Recipes, section 6.2).

const MAX_ITERATIONS = 300;
const EPSILON = 1e-12;
const TINY = 1e-300;

const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

// Lanczos coefficients, written as the doubles they actually round to.
const LANCZOS = [
  76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155,
  0.1208650973866179e-2, -0.5395239384953e-5,
];

function logGamma(x: number): number {
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let series = 1.000000000190015;
  for (const coefficient of LANCZOS) {
    y += 1;
    series += coefficient / y;
  }
  return -tmp + Math.log((SQRT_TWO_PI * series) / x);
}

/** Lower regularised incomplete gamma P(a, x) by series expansion. */
function gammaSeries(a: number, x: number): number {
  let term = 1 / a;
  let sum = term;
  let ap = a;

  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    ap += 1;
    term *= x / ap;
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * EPSILON) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Upper regularised incomplete gamma Q(a, x) by continued fraction. */
function gammaContinuedFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;

  for (let i = 1; i <= MAX_ITERATIONS; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

export function chiSquareSurvival(statistic: number, degreesOfFreedom: number): number {
  if (statistic <= 0) return 1;

  const a = degreesOfFreedom / 2;
  const x = statistic / 2;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}
