import { digitCounts, gapsSinceLastSeen } from "../analysis/digits";
import type { Strategy } from "./types";

/** Deterministic PRNG so every backtest run is reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fair digit series — the control every strategy must be compared against. */
export function fairDigits(count: number, seed = 1): number[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () => Math.floor(random() * 10));
}

function rankedByCount(history: number[], window: number): number[] {
  const counts = digitCounts(history.slice(-window));
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort((a, b) => counts[b] - counts[a]);
}

export function fixedBasket(digits: number[]): Strategy {
  return {
    name: `fixed[${digits.join(",")}]`,
    description: `Always buys Matches on ${digits.join(", ")}.`,
    select: () => digits,
  };
}

export function hottestBasket(size: number, window = 100): Strategy {
  return {
    name: `hottest${size}/${window}`,
    description: `Buys Matches on the ${size} most frequent digits of the last ${window} ticks.`,
    select: ({ history }) => rankedByCount(history, window).slice(0, size),
  };
}

export function coldestBasket(size: number, window = 100): Strategy {
  return {
    name: `coldest${size}/${window}`,
    description: `Buys Matches on the ${size} least frequent digits of the last ${window} ticks.`,
    select: ({ history }) => rankedByCount(history, window).slice(-size),
  };
}

export function longestGapBasket(size: number, window = 200): Strategy {
  return {
    name: `longestGap${size}/${window}`,
    description: `Buys Matches on the ${size} digits absent longest within the last ${window} ticks.`,
    select: ({ history }) => {
      const gaps = gapsSinceLastSeen(history.slice(-window));
      return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        .sort((a, b) => (gaps[b] ?? window) - (gaps[a] ?? window))
        .slice(0, size);
    },
  };
}

/** Only trades once the same digit has repeated, betting the run continues. */
export function afterStreak(minLength: number, size = 1): Strategy {
  return {
    name: `afterStreak${minLength}x${size}`,
    description: `Waits for a digit to repeat ${minLength} times, then buys Matches on it.`,
    select: ({ history }) => {
      if (history.length < minLength) return [];
      const last = history[history.length - 1];
      for (let i = 2; i <= minLength; i += 1) {
        if (history[history.length - i] !== last) return [];
      }
      return size === 1 ? [last] : rankedByCount(history, 100).slice(0, size);
    },
  };
}

export function randomBasket(size: number, seed = 7): Strategy {
  const random = mulberry32(seed);
  return {
    name: `random${size}`,
    description: `Buys Matches on ${size} digits chosen at random — the null hypothesis.`,
    select: () => {
      const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, size);
    },
  };
}
