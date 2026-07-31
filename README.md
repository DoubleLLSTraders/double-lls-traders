# Double LLS Traders

**Secured Deriv Matches / Differs trading desk** — live digit analysis, automated Differs bot, AI operator, and institutional-style risk controls.

> **Private platform.** Access is restricted to authorized Google accounts with Google Authenticator (TOTP) and one-time recovery codes stored as SHA-256 hashes in Firebase Firestore.

**Repository:** [github.com/munyivaemmanuel-rgb/brick-trader](https://github.com/munyivaemmanuel-rgb/brick-trader) (private)

**Hosted app:** https://munyivaemmanuel-rgb.github.io/brick-trader/

---

## Security architecture

| Layer | Protection |
|--------|------------|
| Identity | Google OAuth — allowlisted emails only |
| 2FA | Google Authenticator (TOTP, 30s window) |
| Recovery | 8 cryptographically random one-time codes (SHA-256 hashed in Firestore) |
| Session | 8-hour TTL, browser fingerprint binding, random session token |
| Brute force | 5 failed attempts → 15-minute lockout (per device) |
| Secrets | `.env` gitignored; never commit PATs or OAuth client secrets |
| Firestore | Rules scoped to `totp_secrets/{email}` for authorized operators only |

See [SECURITY.md](./SECURITY.md) for operator checklist and rotation guidance.

---

## Quick start (local)

1. **Deriv** — [Developer dashboard](https://developers.deriv.com/dashboard/) app ID (0% markup, Trade scope).
2. **Demo PAT** — [home.deriv.com → API tokens](https://home.deriv.com/dashboard/profile/api-tokens) with Trade scope.
3. **Google OAuth** — Web client ID with `http://localhost:5173` as authorized origin.
4. **Firebase** — Firestore enabled; publish `firestore.rules`.
5. Copy env and fill in:

```bash
cp .env.example .env
```

Required:

```
VITE_DERIV_APP_ID=
VITE_DERIV_TOKEN_DEMO=
VITE_DERIV_DEMO_ACCOUNT_ID=
VITE_GOOGLE_CLIENT_ID=
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
# + other VITE_FIREBASE_* from Firebase console
```

```bash
npm install
npm run check-auth
npm run dev
```

Open http://localhost:5173 (or `/brick-trader/` if `GITHUB_PAGES=true`).

First login: Google → scan Authenticator QR → **download recovery codes** → enter 6-digit code.

---

## Deploy (GitHub Pages)

Workflow: `.github/workflows/deploy-pages.yml` — runs on push to `master`.

Add **Actions secrets** (Settings → Secrets → Actions) mirroring `.env`:

| Secret | Required |
|--------|----------|
| `VITE_DERIV_APP_ID` | yes |
| `VITE_DERIV_TOKEN_DEMO` | yes |
| `VITE_DERIV_DEMO_ACCOUNT_ID` | recommended |
| `VITE_GOOGLE_CLIENT_ID` | yes |
| `VITE_FIREBASE_*` | yes (all Firebase web config vars) |
| `VITE_TRADING_MODE` | `live` or `paper` |

> Private repos: GitHub Pages may require a paid plan. Alternatively deploy `dist/` to any static host.

---

## Platform features

| Module | Description |
|--------|-------------|
| Live feed | Deriv Options API — OTP WebSocket + REST |
| Market scan | Auto-select best volatility index for Differs |
| Bot | Take-profit runs, bulk contracts, martingale recovery |
| AI operator | Matches side automation with bankroll tracking |
| Backtester | Offline tick replay + Monte Carlo |
| Access gate | Google + TOTP + recovery codes |

---

## Scripts

```bash
npm run dev          # local desk
npm run build        # production bundle
npm run check-auth   # verify Deriv PAT
npm run backtest     # offline strategy replay
npm run find-edge    # scan indices for payout edge
```

---

## Safety defaults

- Demo account + paper mode recommended for development.
- Session caps: daily loss, consecutive losses, max stake in `.env`.
- **Never** paste tokens, recovery codes, or `.env` in chat or screenshots.
- Rotate Deriv PAT and recovery codes if exposure is suspected.

---

## Brand

**Double LLS Traders** — LLS monogram, neon green `#00ff80` on black. Logo assets in `src/assets/` and `public/icon.svg`.

---

## Disclaimer

For analysis and education only. Not financial advice. Synthetic index digits are uniformly random over time; no strategy guarantees profit. Trade only with funds you can afford to lose.
