# Brick Trader

Desktop-ready analysis and trading tool for Deriv Matches / Differs on synthetic indices (starting with Volatility 100).

Currently: live digit analysis in the browser, offline backtester with Monte Carlo ruin analysis. Trade execution is not wired up yet — paper mode is the only path until a strategy survives the backtester.

## Setup

1. Register a web app on the [Deriv developer portal](https://api.deriv.com). Take the `app_id`. Redirect URL can be blank (or any public https URL — localhost is rejected and we don't use OAuth anyway). Authorisation scope: **Trade only**.
2. Create an API token on your **virtual** account with **Read + Trade** scopes. Nothing else.
3. Copy the env template and fill it in:

```bash
cp .env.example .env
```

Required fields:

```
VITE_DERIV_APP_ID=...
VITE_DERIV_TOKEN_DEMO=...
```

Leave `VITE_DERIV_TOKEN_REAL` empty. Keep `VITE_TRADING_MODE=paper` and `VITE_DERIV_ACCOUNT=demo`.

4. Install and run:

```bash
npm install
npm run dev
```

Open http://localhost:5173. You should see a live digit feed for R_100.

## Backtester

Download real ticks (needs `VITE_DERIV_APP_ID` in `.env`):

```bash
npm run fetch-ticks -- --symbol R_100 --count 50000
```

Compare strategies (uses `data/R_100.json` if present, otherwise a fair random control):

```bash
npm run backtest -- --symbol R_100 --payout 9.4
```

`--payout` is the Matches return multiplier including stake (e.g. 9.4 means a $1 win returns $9.40). Check the live quote on Deriv and pass the real number — the house edge is `payout/10 - 1`.

Engine sanity checks:

```bash
npm run verify-backtest
```

## What's in the box

| Piece | Status |
|---|---|
| Deriv WebSocket client (auth, subscribe, heartbeat, reconnect) | done |
| Live digit strip, frequency bars, chi-square uniformity test | done |
| Basket Matches backtester (split / per-contract stake modes) | done |
| Martingale Monte Carlo with ruin rate | done |
| Paper trading | next |
| Live execution + risk kill-switch | later |
| Tauri always-on-top overlay | later (browser first) |

## Safety defaults

- Demo account, paper mode, blank real-money token.
- Daily loss / consecutive-loss / max-stake caps in `.env`.
- `.env` is gitignored. Never paste tokens into chat or screenshots.
