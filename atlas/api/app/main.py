"""Atlas Markets API — FastAPI backend for Gold / Forex / Crypto via Deriv.

Run:  uvicorn app.main:app --reload --port 8787
Env:  DERIV_APP_ID, DERIV_TOKEN (or VITE_DERIV_* from repo .env)
"""

from __future__ import annotations

import asyncio
import csv
import io
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


_load_dotenv()

APP_ID = os.getenv("DERIV_APP_ID") or os.getenv("VITE_DERIV_APP_ID") or ""
TOKEN = (
    os.getenv("DERIV_TOKEN")
    or os.getenv("VITE_DERIV_TOKEN_DEMO")
    or os.getenv("VITE_DERIV_TOKEN")
    or ""
)
REST_URL = (
    os.getenv("DERIV_REST_URL")
    or os.getenv("VITE_DERIV_REST_URL")
    or "https://api.derivws.com"
).rstrip("/")

INSTRUMENTS = [
    {"symbol": "frxXAUUSD", "name": "Gold / USD", "asset_class": "metal", "spread": 0.35},
    {"symbol": "frxEURUSD", "name": "EUR / USD", "asset_class": "forex", "spread": 0.00012},
    {"symbol": "frxGBPUSD", "name": "GBP / USD", "asset_class": "forex", "spread": 0.00016},
    {"symbol": "frxUSDJPY", "name": "USD / JPY", "asset_class": "forex", "spread": 0.016},
    {"symbol": "frxAUDUSD", "name": "AUD / USD", "asset_class": "forex", "spread": 0.00014},
    {"symbol": "cryBTCUSD", "name": "BTC / USD", "asset_class": "crypto", "spread": 22.0},
    {"symbol": "cryETHUSD", "name": "ETH / USD", "asset_class": "crypto", "spread": 1.6},
]

GRANULARITIES = {
    "m1": 60,
    "m5": 300,
    "m15": 900,
    "m30": 1800,
    "h1": 3600,
    "h4": 14400,
    "d1": 86400,
}

app = FastAPI(
    title="Atlas Markets API",
    version="0.1.0",
    description="Real-market research & signals for Deriv. No guaranteed profits.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Deriv HTTP helpers (OTP socket URL + WS via websockets would be ideal;
# for V1 we use the public ticks_history over a short-lived WS session.)
# ---------------------------------------------------------------------------

try:
    import websockets
except ImportError:  # pragma: no cover
    websockets = None  # type: ignore


async def _mint_socket_url() -> str:
    if not APP_ID or not TOKEN:
        raise HTTPException(500, "DERIV_APP_ID / DERIV_TOKEN missing")
    async with httpx.AsyncClient(timeout=20) as client:
        # Prefer Deriv's authorize-via-app websocket endpoint with app_id.
        return f"wss://ws.derivws.com/websockets/v3?app_id={APP_ID}"


async def deriv_request(payload: dict[str, Any]) -> dict[str, Any]:
    if websockets is None:
        raise HTTPException(500, "websockets package not installed")
    import json

    url = await _mint_socket_url()
    async with websockets.connect(url, open_timeout=20, close_timeout=5) as ws:
        if TOKEN:
            await ws.send(json.dumps({"authorize": TOKEN, "req_id": 0}))
            auth = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            if auth.get("error"):
                raise HTTPException(502, auth["error"].get("message", "authorize failed"))
        await ws.send(json.dumps({**payload, "req_id": 1}))
        while True:
            raw = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
            if raw.get("req_id") in (None, 1) or "candles" in raw or "error" in raw:
                if raw.get("error"):
                    raise HTTPException(502, raw["error"].get("message", "deriv error"))
                return raw


# ---------------------------------------------------------------------------
# Indicators / patterns / signal (Python port of atlas TS engine)
# ---------------------------------------------------------------------------


@dataclass
class Bar:
    epoch: int
    open: float
    high: float
    low: float
    close: float


def ema(values: list[float], period: int) -> list[float]:
    out = [math.nan] * len(values)
    if len(values) < period:
        return out
    k = 2 / (period + 1)
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    for i in range(period, len(values)):
        out[i] = values[i] * k + out[i - 1] * (1 - k)
    return out


def sma(values: list[float], period: int) -> list[float]:
    out = [math.nan] * len(values)
    s = 0.0
    for i, v in enumerate(values):
        s += v
        if i >= period:
            s -= values[i - period]
        if i >= period - 1:
            out[i] = s / period
    return out


def atr_series(bars: list[Bar], period: int = 14) -> list[float]:
    out = [math.nan] * len(bars)
    if len(bars) < period + 1:
        return out
    tr = [math.nan]
    for i in range(1, len(bars)):
        prev = bars[i - 1].close
        tr.append(
            max(
                bars[i].high - bars[i].low,
                abs(bars[i].high - prev),
                abs(bars[i].low - prev),
            )
        )
    s = sum(tr[1 : period + 1])
    out[period] = s / period
    for i in range(period + 1, len(bars)):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return out


def rsi(closes: list[float], period: int = 14) -> list[float]:
    out = [math.nan] * len(closes)
    if len(closes) <= period:
        return out
    gain = loss = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d >= 0:
            gain += d
        else:
            loss -= d
    avg_gain = gain / period
    avg_loss = loss / period
    out[period] = 100 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(d, 0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-d, 0)) / period
        out[i] = 100 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return out


class RiskConfig(BaseModel):
    risk_per_trade_pct: float = 1.0
    daily_loss_limit_pct: float = 3.0
    max_open_trades: int = 2
    max_consecutive_losses: int = 4
    max_daily_trades: int = 20
    paused: bool = False
    paper_mode: bool = True


class RiskState(BaseModel):
    equity: float
    day_pnl: float = 0
    open_trades: int = 0
    consecutive_losses: int = 0
    day_trades: int = 0


class RiskCheckRequest(BaseModel):
    config: RiskConfig = Field(default_factory=RiskConfig)
    state: RiskState
    stop_distance: float
    price: float


class PaperOrderRequest(BaseModel):
    symbol: str
    side: Literal["buy", "sell"]
    entry: float
    stop: float
    target: float
    reason: str = ""
    config: RiskConfig = Field(default_factory=RiskConfig)
    state: RiskState


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "atlas-api",
        "deriv_configured": bool(APP_ID and TOKEN),
        "disclaimer": "No guaranteed profits. Research and risk tooling only.",
    }


@app.get("/symbols")
async def symbols() -> list[dict[str, Any]]:
    return INSTRUMENTS


@app.get("/candles")
async def candles(
    symbol: str = Query(...),
    timeframe: str = Query("h1"),
    count: int = Query(500, ge=50, le=5000),
) -> dict[str, Any]:
    gran = GRANULARITIES.get(timeframe)
    if gran is None:
        raise HTTPException(400, f"Unknown timeframe {timeframe}")
    raw = await deriv_request(
        {
            "ticks_history": symbol,
            "adjust_start_time": 1,
            "style": "candles",
            "granularity": gran,
            "count": count,
            "end": "latest",
        }
    )
    bars = []
    for c in raw.get("candles") or []:
        bars.append(
            {
                "epoch": c["epoch"],
                "open": float(c["open"]),
                "high": float(c["high"]),
                "low": float(c["low"]),
                "close": float(c["close"]),
            }
        )
    return {"symbol": symbol, "timeframe": timeframe, "bars": bars}


def _bars_from(payload: list[dict[str, Any]]) -> list[Bar]:
    return [
        Bar(
            epoch=int(b["epoch"]),
            open=float(b["open"]),
            high=float(b["high"]),
            low=float(b["low"]),
            close=float(b["close"]),
        )
        for b in payload
    ]


@app.post("/indicators")
async def indicators(body: dict[str, Any]) -> dict[str, Any]:
    bars = _bars_from(body.get("bars") or [])
    if len(bars) < 60:
        raise HTTPException(400, "Need at least 60 bars")
    closes = [b.close for b in bars]
    e20 = ema(closes, 20)
    e50 = ema(closes, 50)
    s200 = sma(closes, 200)
    r = rsi(closes, 14)
    a = atr_series(bars, 14)
    i = len(bars) - 1
    return {
        "ema20": e20[i],
        "ema50": e50[i],
        "sma200": None if math.isnan(s200[i]) else s200[i],
        "rsi14": r[i],
        "atr14": a[i],
    }


@app.post("/signal")
async def signal(body: dict[str, Any]) -> dict[str, Any]:
    bars = _bars_from(body.get("bars") or [])
    spread = float(body.get("spread") or 0.00012)
    if len(bars) < 60:
        raise HTTPException(400, "Need at least 60 bars")
    closes = [b.close for b in bars]
    e20 = ema(closes, 20)
    e50 = ema(closes, 50)
    r = rsi(closes, 14)
    a = atr_series(bars, 14)
    i = len(bars) - 1
    buy = sell = 33.0
    if e20[i] > e50[i]:
        buy += 14
    else:
        sell += 14
    if r[i] < 35:
        buy += 10
    elif r[i] > 65:
        sell += 10
    total = buy + sell + 34
    buy_p = buy / total * 100
    sell_p = sell / total * 100
    neu = 100 - buy_p - sell_p
    bias = "buy" if buy_p >= sell_p and buy_p >= neu else "sell" if sell_p >= neu else "neutral"
    atr = max(a[i] if not math.isnan(a[i]) else 0, spread * 2, bars[i].close * 0.0005)
    conf = min(90.0, max(25.0, max(buy_p, sell_p, neu) - 5))
    explanation = (
        f"EMA20 {'above' if e20[i] > e50[i] else 'below'} EMA50; RSI {r[i]:.1f}. "
        f"Bias {bias.upper()} is a scored estimate — not a guarantee."
    )
    return {
        "bias": bias,
        "buyProbability": buy_p,
        "sellProbability": sell_p,
        "neutralProbability": neu,
        "confidence": conf,
        "riskScore": 40 if bias != "neutral" else 60,
        "expectedRR": 2.0,
        "expectedHoldBars": 12,
        "explanation": explanation,
        "stopDistance": atr * 1.2,
        "targetDistance": atr * 2.2,
    }


@app.post("/risk/check")
async def risk_check(req: RiskCheckRequest) -> dict[str, Any]:
    reasons: list[str] = []
    c, s = req.config, req.state
    if c.paused:
        reasons.append("Trading paused by risk switch")
    if s.open_trades >= c.max_open_trades:
        reasons.append(f"Max open trades ({c.max_open_trades}) reached")
    if s.consecutive_losses >= c.max_consecutive_losses:
        reasons.append(f"Max consecutive losses ({c.max_consecutive_losses}) hit")
    if s.day_trades >= c.max_daily_trades:
        reasons.append(f"Max daily trades ({c.max_daily_trades}) reached")
    limit = (c.daily_loss_limit_pct / 100) * s.equity
    if s.day_pnl <= -limit:
        reasons.append(f"Daily loss limit {c.daily_loss_limit_pct}% breached")
    if req.stop_distance <= 0 or req.price <= 0 or s.equity <= 0:
        reasons.append("Invalid price, stop, or equity")
    risk_cash = (c.risk_per_trade_pct / 100) * s.equity
    units = risk_cash / req.stop_distance if req.stop_distance > 0 else 0
    return {
        "ok": len(reasons) == 0,
        "reasons": reasons,
        "positionNotional": units * req.price,
    }


_PAPER_ORDERS: list[dict[str, Any]] = []


@app.post("/execute/paper")
async def execute_paper(req: PaperOrderRequest) -> dict[str, Any]:
    check = await risk_check(
        RiskCheckRequest(
            config=req.config,
            state=req.state,
            stop_distance=abs(req.entry - req.stop),
            price=req.entry,
        )
    )
    if not check["ok"]:
        raise HTTPException(403, {"message": "Risk gate blocked", "reasons": check["reasons"]})
    if not req.config.paper_mode:
        raise HTTPException(403, "Live execution not enabled in V1 — paper only")
    order = {
        "id": f"paper-{len(_PAPER_ORDERS) + 1}",
        "symbol": req.symbol,
        "side": req.side,
        "entry": req.entry,
        "stop": req.stop,
        "target": req.target,
        "reason": req.reason,
        "status": "open",
    }
    _PAPER_ORDERS.append(order)
    return {"ok": True, "order": order}


@app.post("/backtest")
async def backtest(body: dict[str, Any]) -> dict[str, Any]:
    bars = _bars_from(body.get("bars") or [])
    spread = float(body.get("spread") or 0.00012)
    atr_mult = float(body.get("atrMult") or 1.2)
    r_mult = float(body.get("rMultiple") or 2.0)
    if len(bars) < 80:
        raise HTTPException(400, "Need at least 80 bars")
    closes = [b.close for b in bars]
    e20 = ema(closes, 20)
    e50 = ema(closes, 50)
    atr = atr_series(bars, 14)
    results: list[float] = []
    i = 50
    while i < len(bars) - 1:
        signal = 0
        if not math.isnan(e20[i]) and not math.isnan(e50[i]):
            if e20[i - 1] <= e50[i - 1] and e20[i] > e50[i]:
                signal = 1
            elif e20[i - 1] >= e50[i - 1] and e20[i] < e50[i]:
                signal = -1
        risk = atr[i] * atr_mult if not math.isnan(atr[i]) else 0
        if signal == 0 or risk <= 0:
            i += 1
            continue
        long = signal == 1
        entry = bars[i + 1].open + (spread / 2 if long else -spread / 2)
        stop = entry - risk if long else entry + risk
        target = entry + risk * r_mult if long else entry - risk * r_mult
        gross = None
        exit_i = i + 1
        last = min(len(bars) - 1, i + 61)
        for j in range(i + 1, last + 1):
            bar = bars[j]
            if (long and bar.low <= stop) or (not long and bar.high >= stop):
                gross = -1.0
                exit_i = j
                break
            if (long and bar.high >= target) or (not long and bar.low <= target):
                gross = r_mult
                exit_i = j
                break
        if gross is None:
            exit_px = bars[last].close
            gross = ((exit_px - entry) if long else (entry - exit_px)) / risk
            exit_i = last
        results.append(gross - spread / risk)
        i = exit_i + 1
    if not results:
        return {"trades": 0, "wins": 0, "winRate": 0, "profitFactor": 0, "expectancyR": 0, "totalR": 0, "maxDrawdownR": 0}
    wins = sum(1 for r in results if r > 0)
    gp = sum(r for r in results if r > 0)
    gl = sum(-r for r in results if r <= 0)
    equity = peak = max_dd = 0.0
    for r in results:
        equity += r
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
    return {
        "trades": len(results),
        "wins": wins,
        "winRate": wins / len(results) * 100,
        "profitFactor": (gp / gl) if gl > 0 else gp,
        "expectancyR": sum(results) / len(results),
        "totalR": sum(results),
        "maxDrawdownR": max_dd,
    }


@app.post("/backtest/csv", response_class=PlainTextResponse)
async def backtest_csv(body: dict[str, Any]) -> str:
    result = await backtest(body)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(result.keys())
    w.writerow(result.values())
    return buf.getvalue()


@app.get("/strategies")
async def strategies() -> list[dict[str, str]]:
    return [
        {"id": "trend", "name": "Trend following", "description": "EMA cross with ATR stops"},
        {"id": "pullback", "name": "Pullback entry", "description": "Buy dips in uptrend"},
        {"id": "breakout", "name": "Breakout confirmation", "description": "Donchian breakout"},
        {"id": "meanReversion", "name": "Mean reversion", "description": "Fade BB extremes"},
    ]
