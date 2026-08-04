import { useEffect, useRef } from "react";
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import { ema } from "./indicators";
import type { AtlasBar } from "./instruments";
import {
  priceMatchesSymbol,
  type AtlasJournalTrade,
} from "./journal";

/** How many recent bars to show — zoomed in so swings are readable. */
const VISIBLE_BARS = 64;

function toSec(msOrSec: number): number {
  return msOrSec > 1e12 ? Math.floor(msOrSec / 1000) : Math.floor(msOrSec);
}

/** Markers must land on an existing bar time. */
function snapToBar(bars: AtlasBar[], epochMsOrSec: number): UTCTimestamp | null {
  if (bars.length === 0) return null;
  const t = toSec(epochMsOrSec);
  let best = bars[0].epoch;
  let bestDist = Math.abs(best - t);
  for (const b of bars) {
    const d = Math.abs(b.epoch - t);
    if (d < bestDist) {
      best = b.epoch;
      bestDist = d;
    }
  }
  return best as UTCTimestamp;
}

function applyZoom(chart: IChartApi, barCount: number) {
  const from = Math.max(0, barCount - VISIBLE_BARS);
  const to = Math.max(barCount - 1, 0) + 3;
  chart.timeScale().setVisibleLogicalRange({ from, to });
}

export function AtlasChart({
  bars,
  mode = "candles",
  trades = [],
  symbol,
  theme = "dark",
  settlePopup = null,
  openSide = null,
}: {
  bars: AtlasBar[];
  mode?: "candles" | "line";
  trades?: AtlasJournalTrade[];
  symbol?: string;
  theme?: "dark" | "light";
  settlePopup?: {
    kind: "win" | "loss";
    profit: number;
    currency: string;
    balance: number;
  } | null;
  openSide?: "buy" | "sell" | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null>(
    null,
  );
  const ema20Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ema50Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const modeRef = useRef(mode);
  const zoomedLenRef = useRef(0);

  const isLight = theme === "light";
  const colors = isLight
    ? {
        bg: "#ffffff",
        text: "#5a6a7c",
        grid: "rgba(180, 192, 208, 0.55)",
        border: "#cfd8e3",
        cross: "rgba(90, 110, 130, 0.35)",
        labelBg: "#eef2f7",
        ema20: "#1a7aab",
        ema50: "#a67910",
        up: "#0b8f63",
        down: "#c93b52",
        line: "#14202b",
      }
    : {
        bg: "#0a0e14",
        text: "#7d8b9c",
        grid: "rgba(28, 38, 52, 0.55)",
        border: "#1c2634",
        cross: "rgba(125, 160, 190, 0.35)",
        labelBg: "#151d28",
        ema20: "#5ad0ff",
        ema50: "#f0c45a",
        up: "#26a69a",
        down: "#ef5350",
        line: "#d8e2ec",
      };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      layout: {
        background: { color: colors.bg },
        textColor: colors.text,
        fontSize: 11,
        fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: colors.grid, style: LineStyle.Dotted },
        horzLines: { color: colors.grid, style: LineStyle.Dotted },
      },
      rightPriceScale: {
        borderColor: colors.border,
        scaleMargins: { top: 0.06, bottom: 0.18 },
        entireTextOnly: true,
      },
      leftPriceScale: { visible: false },
      timeScale: {
        borderColor: colors.border,
        rightOffset: 6,
        barSpacing: 11,
        minBarSpacing: 5,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: colors.cross,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: colors.labelBg,
        },
        horzLine: {
          color: colors.cross,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: colors.labelBg,
        },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    chartRef.current = chart;

    volRef.current = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: isLight ? "rgba(26, 122, 171, 0.3)" : "rgba(90, 208, 255, 0.35)",
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    ema20Ref.current = chart.addLineSeries({
      color: colors.ema20,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    ema50Ref.current = chart.addLineSeries({
      color: colors.ema50,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: host.clientWidth, height: host.clientHeight });
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      ema20Ref.current = null;
      ema50Ref.current = null;
      volRef.current = null;
      priceLinesRef.current = [];
    };
    // Recreate chart when theme flips so colors stay correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (seriesRef.current) {
      chart.removeSeries(seriesRef.current);
      seriesRef.current = null;
    }
    priceLinesRef.current = [];
    modeRef.current = mode;
    if (mode === "line") {
      seriesRef.current = chart.addLineSeries({
        color: colors.line,
        lineWidth: 2,
        priceLineVisible: true,
        lastValueVisible: true,
        priceLineColor: isLight
          ? "rgba(20, 32, 43, 0.3)"
          : "rgba(216, 226, 236, 0.35)",
        priceLineStyle: LineStyle.Dashed,
      });
    } else {
      seriesRef.current = chart.addCandlestickSeries({
        upColor: colors.up,
        downColor: colors.down,
        borderUpColor: colors.up,
        borderDownColor: colors.down,
        wickUpColor: colors.up,
        wickDownColor: colors.down,
        priceLineVisible: true,
        lastValueVisible: true,
        priceLineColor: isLight
          ? "rgba(201, 59, 82, 0.4)"
          : "rgba(239, 83, 80, 0.45)",
        priceLineStyle: LineStyle.Dashed,
      });
    }
    zoomedLenRef.current = 0;
  }, [mode, theme, colors.line, colors.up, colors.down, isLight]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart || bars.length === 0) return;

    const closes = bars.map((b) => b.close);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);

    if (modeRef.current === "line") {
      (series as ISeriesApi<"Line">).setData(
        bars.map((b) => ({
          time: b.epoch as UTCTimestamp,
          value: b.close,
        })),
      );
    } else {
      (series as ISeriesApi<"Candlestick">).setData(
        bars.map((b) => ({
          time: b.epoch as UTCTimestamp,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        })),
      );
    }

    ema20Ref.current?.setData(
      bars
        .map((b, i) =>
          Number.isFinite(e20[i])
            ? { time: b.epoch as UTCTimestamp, value: e20[i] }
            : null,
        )
        .filter(Boolean) as { time: UTCTimestamp; value: number }[],
    );
    ema50Ref.current?.setData(
      bars
        .map((b, i) =>
          Number.isFinite(e50[i])
            ? { time: b.epoch as UTCTimestamp, value: e50[i] }
            : null,
        )
        .filter(Boolean) as { time: UTCTimestamp; value: number }[],
    );

    volRef.current?.setData(
      bars.map((b) => {
        const range = Math.max(b.high - b.low, 1e-9);
        const bull = b.close >= b.open;
        return {
          time: b.epoch as UTCTimestamp,
          value: range,
          color: bull
            ? "rgba(38, 166, 154, 0.35)"
            : "rgba(239, 83, 80, 0.35)",
        };
      }),
    );

    for (const line of priceLinesRef.current) {
      try {
        series.removePriceLine(line);
      } catch {
        /* ignore */
      }
    }
    priceLinesRef.current = [];

    const relevant = trades.filter((t) => !symbol || t.symbol === symbol);
    const open = relevant.filter((t) => t.result === "open");
    for (const t of open.slice(0, 3)) {
      priceLinesRef.current.push(
        series.createPriceLine({
          price: t.entry,
          color: "#5ad0ff",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "Entry",
        }),
      );
      priceLinesRef.current.push(
        series.createPriceLine({
          price: t.stop,
          color: "#ef5350",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "SL",
        }),
      );
      priceLinesRef.current.push(
        series.createPriceLine({
          price: t.target,
          color: "#26a69a",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "TP",
        }),
      );
    }

    // Soft settle marks — wins only; never show voided ghost fills.
    const settled = relevant
      .filter((t) => t.result === "win")
      .filter((t) => priceMatchesSymbol(t.symbol, t.entry))
      .filter((t) => !/voided|ghost|absurd|inconsistent/i.test(t.reason))
      .filter((t) => {
        const cash = Number(t.pnlCash) || 0;
        return cash > 0.005 && cash < 80;
      })
      .sort((a, b) => (b.settledAt ?? b.at) - (a.settledAt ?? a.at))
      .slice(0, 8);

    const markers: SeriesMarker<UTCTimestamp>[] = [];
    const usedTimes = new Set<number>();

    for (const t of settled) {
      const cash = Number.isFinite(t.pnlCash) ? Number(t.pnlCash) : 0;
      if (cash < 0.005) continue;

      const exitTime = snapToBar(bars, t.settledAt ?? t.at);
      if (!exitTime) continue;
      const tKey = exitTime as number;
      if (usedTimes.has(tKey)) continue;
      usedTimes.add(tKey);

      markers.push({
        time: exitTime,
        position: "aboveBar",
        color: "rgba(61, 200, 160, 0.7)",
        shape: "circle",
        text: `+${cash.toFixed(2)}`,
      });
    }

    // Open trade: one quiet entry arrow only.
    for (const t of open.slice(0, 1)) {
      const entryTime = snapToBar(bars, t.at);
      if (!entryTime) continue;
      markers.push({
        time: entryTime,
        position: t.side === "buy" ? "belowBar" : "aboveBar",
        color:
          t.side === "buy"
            ? "rgba(61, 200, 160, 0.55)"
            : "rgba(230, 110, 130, 0.55)",
        shape: t.side === "buy" ? "arrowUp" : "arrowDown",
        text: "",
      });
    }

    markers.sort((a, b) => (a.time as number) - (b.time as number));
    series.setMarkers(markers);

    // Re-zoom only when history length jumps (not every tick update).
    if (Math.abs(bars.length - zoomedLenRef.current) >= 2 || zoomedLenRef.current === 0) {
      applyZoom(chart, bars.length);
      zoomedLenRef.current = bars.length;
    }
  }, [bars, mode, trades, symbol]);

  return (
    <div className="atlas-chart-wrap">
      <div className="atlas-chart-legend">
        <span className="is-ema20">EMA20</span>
        <span className="is-ema50">EMA50</span>
        <span className="is-vol">Range vol</span>
      </div>
      {openSide && !settlePopup ? (
        <div
          className={`atlas-chart-coach is-${openSide}`}
          role="status"
        >
          {openSide === "sell" ? (
            <>
              <strong>SELL in play</strong>
              <span>
                Want candles <em>down</em> under Entry → Target. Up toward Stop
                = loss.
              </span>
            </>
          ) : (
            <>
              <strong>BUY in play</strong>
              <span>
                Want candles <em>up</em> over Entry → Target. Down toward Stop =
                loss.
              </span>
            </>
          )}
        </div>
      ) : null}
      <div className="atlas-chart" ref={hostRef} />
      {settlePopup ? (
        <div
          key={`${settlePopup.profit}-${settlePopup.balance}`}
          className={`atlas-chart-result atlas-chart-result--${
            settlePopup.profit > 0.004
              ? "win"
              : settlePopup.profit < -0.004
                ? "loss"
                : "flat"
          }`}
          role="status"
          aria-live="polite"
        >
          <strong>
            {settlePopup.profit > 0.004
              ? "WIN"
              : settlePopup.profit < -0.004
                ? "LOSS"
                : "CLOSED"}
          </strong>
          <em>
            {settlePopup.profit >= 0 ? "+" : ""}
            {settlePopup.profit.toFixed(2)} {settlePopup.currency}
          </em>
        </div>
      ) : null}
    </div>
  );
}
