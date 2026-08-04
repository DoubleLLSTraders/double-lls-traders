import { useEffect, useRef, useState } from "react";
import type { DerivClient } from "../lib/deriv/client";
import {
  runMarketSweep,
  type MarketSweep,
} from "../lib/analysis/marketSweep";

/** Full board re-read cadence. One pass costs ten paced history calls. */
const SWEEP_INTERVAL_MS = 45_000;

/**
 * Continuous deep sweep of every volatility index while the Over/Under desk
 * is idle. Disabled while the bot runs so hops are not starved by 2000-tick
 * history calls (that was leaving "Moving to steadier market" stuck for minutes).
 */
export function useMarketSweep(
  client: DerivClient | null,
  enabled: boolean,
): { sweep: MarketSweep | null; scanning: boolean } {
  const [sweep, setSweep] = useState<MarketSweep | null>(null);
  const [scanning, setScanning] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!client || !enabled) return;
    let cancelled = false;

    const pass = async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      setScanning(true);
      try {
        const result = await runMarketSweep(client, () => cancelled);
        if (!cancelled && result && result.scannedMarkets > 0) {
          setSweep(result);
        }
      } finally {
        busyRef.current = false;
        if (!cancelled) setScanning(false);
      }
    };

    void pass();
    const id = window.setInterval(() => void pass(), SWEEP_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [client, enabled]);

  return { sweep, scanning };
}
