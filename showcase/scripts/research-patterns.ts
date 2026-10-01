/**
 * Looks for exploitable structure in real Deriv digits: frequency bias, next-digit dependence,
 * repeats, and parity / high-low streak behaviour. Reads showcase/data/real-ticks.json.
 */
import { readFile } from "node:fs/promises";

const { symbols } = JSON.parse(await readFile("showcase/data/real-ticks.json", "utf8")) as { symbols: Record<string, number[]> };

/** Upper-tail p-value of a chi-square statistic (Wilson–Hilferty approximation). */
function chiP(chi: number, df: number) {
  const z = (Math.cbrt(chi / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return 0.5 * erfc(z / Math.SQRT2);
}
function erfc(x: number) {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : 2 - y;
}

console.log("symbol     ticks   freq p    transition p   repeat%   parity-continue%   high-continue%   after-3-same-parity%");
const all: number[] = [];
for (const [sym, d] of Object.entries(symbols)) {
  all.push(...d);
  const n = d.length;
  const freq = new Array(10).fill(0);
  for (const x of d) freq[x]++;
  const e = n / 10;
  const chiF = freq.reduce((a, x) => a + (x - e) ** 2 / e, 0);

  const T = Array.from({ length: 10 }, () => new Array(10).fill(0));
  for (let i = 1; i < n; i++) T[d[i - 1]][d[i]]++;
  let chiT = 0;
  for (let a = 0; a < 10; a++) {
    const row = T[a].reduce((s, x) => s + x, 0);
    for (let b = 0; b < 10; b++) {
      const ex = row * (freq[b] / n);
      chiT += (T[a][b] - ex) ** 2 / ex;
    }
  }

  let rep = 0, parSame = 0, hiSame = 0, run3 = 0, run3Cont = 0;
  for (let i = 1; i < n; i++) {
    if (d[i] === d[i - 1]) rep++;
    if (d[i] % 2 === d[i - 1] % 2) parSame++;
    if ((d[i] >= 5) === (d[i - 1] >= 5)) hiSame++;
    if (i >= 3 && d[i - 1] % 2 === d[i - 2] % 2 && d[i - 2] % 2 === d[i - 3] % 2) {
      run3++;
      if (d[i] % 2 === d[i - 1] % 2) run3Cont++;
    }
  }
  console.log(
    `${sym.padEnd(9)} ${String(n).padStart(6)}   ${chiP(chiF, 9).toFixed(3).padStart(6)}    ${chiP(chiT, 81).toFixed(3).padStart(8)}     ${((rep / (n - 1)) * 100).toFixed(2).padStart(6)}       ${((parSame / (n - 1)) * 100).toFixed(2).padStart(6)}            ${((hiSame / (n - 1)) * 100).toFixed(2).padStart(6)}           ${((run3Cont / run3) * 100).toFixed(2).padStart(6)}`,
  );
}
console.log(`\nExpected if random: freq p and transition p spread evenly over 0–1, repeat 10.00%, continue rates 50.00%. Pooled ticks: ${all.length}.`);
