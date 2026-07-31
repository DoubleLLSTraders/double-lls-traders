# Brick Trader

Live Deriv Matches / Differs analysis and bot for synthetic indices (Volatility 75 and others).

**Public app (after deploy):** https://munyivaemmanuel-rgb.github.io/brick-trader/

**Source repo:** https://github.com/munyivaemmanuel-rgb/brick-trader

## Setup (local)

1. Register an app on the [Deriv developer dashboard](https://developers.deriv.com/dashboard/). Copy the App ID. Markup must be **0%**. Authorisation scope: **Trade** only.
2. Create a Personal Access Token on your **Demo** account at [home.deriv.com → profile → API tokens](https://home.deriv.com/dashboard/profile/api-tokens) with **Trade** scope.
3. Copy the env template and fill it in:

```bash
cp .env.example .env
```

Required fields:

```
VITE_DERIV_APP_ID=...
VITE_DERIV_TOKEN_DEMO=...
VITE_DERIV_DEMO_ACCOUNT_ID=DOT...   # from npm run check-auth
```

Leave `VITE_DERIV_TOKEN_REAL` empty. Keep `VITE_TRADING_MODE=paper` and `VITE_DERIV_ACCOUNT=demo`.

4. Install and run:

```bash
npm install
npm run check-auth
npm run dev
```

Open http://localhost:5173. You should see your demo balance and a live digit feed.

## Deploy (GitHub Pages — use on any device)

Every push to `master` builds and publishes the site.

1. Make the repo **public** (Settings → General → Danger zone → Change visibility).
2. Enable **Pages**: Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Add **Actions secrets** (Settings → Secrets and variables → Actions → New repository secret). Copy values from your local `.env`:

| Secret | Required |
|--------|----------|
| `VITE_DERIV_APP_ID` | yes |
| `VITE_DERIV_TOKEN_DEMO` | yes |
| `VITE_DERIV_DEMO_ACCOUNT_ID` | recommended |
| `VITE_TRADING_MODE` | `live` or `paper` |
| `VITE_DERIV_TOKEN_REAL` | optional |
| `VITE_DERIV_REAL_ACCOUNT_ID` | optional |

4. Push to `master`. Check **Actions** tab for the deploy workflow, then open:

   **https://munyivaemmanuel-rgb.github.io/brick-trader/**

Tokens are baked in at build time (Vite). To rotate keys, update secrets and re-run the workflow.

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
| Deriv Options REST + OTP WebSocket client | done |
| Live digit analysis, bot panel, market scan | done |
| Demo / real account switcher | done |
| Live Differs bot (take-profit, bulk contracts) | done |
| AI Operator (Matches) | done |
| Offline backtester + Monte Carlo | done |

## Safety defaults

- Demo account, paper mode, blank real-money token.
- Daily loss / consecutive-loss / max-stake caps in `.env`.
- `.env` is gitignored. Never paste tokens into chat or screenshots.
