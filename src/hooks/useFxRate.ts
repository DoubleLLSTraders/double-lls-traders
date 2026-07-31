import { useEffect, useState } from "react";

const REFRESH_MS = 60_000;
const FALLBACK_URL = (base: string) =>
  `https://latest.currency-api.pages.dev/v1/currencies/${base}.min.json`;
const PRIMARY_URL = (base: string) =>
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base}.min.json`;

async function fetchKesRate(fromCurrency: string): Promise<number | null> {
  const base = fromCurrency.trim().toLowerCase();
  if (!base) return null;
  if (base === "kes") return 1;

  for (const url of [PRIMARY_URL(base), FALLBACK_URL(base)]) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const data = (await response.json()) as Record<string, Record<string, number> | string>;
      const rates = data[base];
      if (rates && typeof rates === "object" && typeof rates.kes === "number") {
        return rates.kes;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Live FX rate: 1 unit of `fromCurrency` → KES. Refreshes about every minute. */
export function useKesRate(fromCurrency: string) {
  const [rate, setRate] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const next = await fetchKesRate(fromCurrency);
      if (cancelled || next === null) return;
      setRate(next);
      setUpdatedAt(Date.now());
    };

    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [fromCurrency]);

  return { rate, updatedAt };
}
