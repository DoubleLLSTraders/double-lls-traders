# Atlas Markets Hub

Institutional-style **Gold / Forex / Crypto** research and paper-trading hub for Deriv.

This tree is **isolated** from the Digits / Matches / Over-Under desk. Switching hubs in Settings never shares bot state.

## Disclaimer

**No guaranteed profits.** Every recommendation includes confidence, estimated risk, and an explanation. Automated execution is paper-mode by default and is blocked unless risk gates pass.

## What ships in V1

- Hub switch in the main app Settings → **Hub** (Digits desk ↔ Atlas)
- Editable display name (default `Atlas`)
- Dashboard with Lightweight Charts, multi-timeframe candles from Deriv
- Indicators: EMA, SMA, RSI, MACD, ATR, Bollinger, ADX
- Pattern detection (Doji, Hammer, Engulfing, Stars…)
- Explainable AI signal (buy / sell / neutral probabilities)
- Strategies: trend, pullback, breakout, mean reversion + backtest CSV
- Hard risk gates (1% risk default, daily loss, max trades, pause)
- FastAPI backend under `atlas/api` (optional; UI works client-side without it)
- Docker Compose scaffold (API + Postgres + Redis)

## Quick start (embedded UI)

1. Use the main app as usual: `npm run dev`
2. Open **Settings → Hub**
3. Name the hub if you want, select **Atlas**, confirm

## API

```bash
cd atlas/api
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8787
```

Health: `http://127.0.0.1:8787/health`

## Docker

```bash
cd atlas
docker compose up --build atlas-api
```

## Phase 2 (scaffold only)

LSTM / Transformer training, Telegram / WhatsApp alerts, full drawing tools, Celery workers, Nginx hardening, journal screenshots.

## Layout

```
atlas/
  api/           FastAPI
  web/           Standalone notes / thin client
  docs/INSTALL.md
  docker-compose.yml
  README.md
```

Embedded React UI lives in `src/hubs/atlas/` so the Settings switch works inside the existing Vite app without a second frontend process.
