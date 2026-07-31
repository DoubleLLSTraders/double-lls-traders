<div align="center">

<img src="./logo-exports/logo-256-transparent.png" alt="Double LLS Traders" width="120" />

# Double LLS Traders

**Institutional-grade Deriv Matches / Differs trading desk**

[![Private](https://img.shields.io/badge/access-private-000000?style=for-the-badge&logo=github&logoColor=00ff80)](https://github.com/DoubleLLSTraders/double-lls-traders)
[![Stack](https://img.shields.io/badge/stack-React%20%7C%20TypeScript%20%7C%20Vite-043825?style=for-the-badge&logo=react&logoColor=00ff80)](./package.json)
[![Deriv](https://img.shields.io/badge/Deriv-Options%20API-0a5c3a?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgZmlsbD0iIzAwZmY4MCIgdmlld0JveD0iMCAwIDE2IDE2Ij48Y2lyY2xlIGN4PSI4IiBjeT0iOCIgcj0iNiIvPjwvc3ZnPg==)](https://developers.deriv.com/)
[![Security](https://img.shields.io/badge/security-Google%20%2B%20TOTP%20%2B%20Firestore-000000?style=for-the-badge&logo=google&logoColor=00ff80)](./SECURITY.md)

Live digit analysis · automated Differs engine · AI operator · hardened risk rails · operator-only access

**[Launch desk →](https://doublellstraders.github.io/double-lls-traders/)** · **[Repository →](https://github.com/DoubleLLSTraders/double-lls-traders)** *(private)*

<br />

<img src="./logo-exports/logo-light-256-transparent.png" alt="Double LLS Traders light mark" width="80" />

<br />

<sub>Designed & built by <strong>Joseph Nyarandi</strong></sub><br />
<sub><em>Double LLS Traders · precision over noise</em></sub>

</div>

---

## What this is

**Double LLS Traders** is a secured, browser-native command center for **Deriv synthetic indices** — built around **Matches** and **Differs** digit contracts. It ingests live ticks over the Options API, runs multi-window statistical gates, executes paper or live bot cycles, and wraps the entire surface in **Google OAuth + Google Authenticator (TOTP)** before a single candle loads.

This is not a toy dashboard. It is a **closed operator platform**: allowlisted identities, hashed recovery codes, session binding, daily loss caps, consecutive-loss brakes, and take-profit run logic — the kind of stack you expect on a prop desk, implemented as a modern SPA.

---

## Brand palette

| Swatch | Hex | Role |
|:------:|:---:|:-----|
| ![#000000](https://img.shields.io/badge/‑-000000?style=flat-square) | `#000000` | Void black — primary canvas |
| ![#00ff80](https://img.shields.io/badge/‑-00ff80?style=flat-square) | `#00ff80` | Neon signal — accent, cold digits, live edge |
| ![#ffffff](https://img.shields.io/badge/‑-ffffff?style=flat-square) | `#ffffff` | Pure white — typography & LLS monogram |
| ![#043825](https://img.shields.io/badge/‑-043825?style=flat-square) | `#043825` | Deep forest — panels & depth |
| ![#0a5c3a](https://img.shields.io/badge/‑-0a5c3a?style=flat-square) | `#0a5c3a` | Mid green — borders & secondary chrome |

Logo assets: [`logo-exports/`](./logo-exports/) · [`public/`](./public/) · [`src/assets/`](./src/assets/)

---

## Platform architecture

```mermaid
%%{init: {'theme':'dark', 'themeVariables': {'primaryColor':'#00ff80','primaryTextColor':'#000000','secondaryColor':'#043825','tertiaryColor':'#0a5c3a','lineColor':'#00ff80','fontFamily':'ui-sans-serif'}}}%%
flowchart TB
    subgraph ACCESS["🔐 Access layer"]
        G[Google OAuth]
        T[TOTP · Google Authenticator]
        R[Recovery codes · SHA-256 in Firestore]
        S[8h session · device fingerprint]
    end

    subgraph FEED["📡 Market feed"]
        WS[Deriv OTP WebSocket]
        REST[Deriv REST API]
        DIG[Digit distribution engine]
    end

    subgraph CORE["⚙️ Decision core"]
        SCAN[Multi-index market scan]
        SIG[Signal gates · EV · Wilson bounds]
        BOT[Differs bot · take-profit runs]
        AI[AI operator · Matches side]
    end

    subgraph RISK["🛡️ Risk rails"]
        DL[Daily loss limit]
        CL[Consecutive loss cap]
        ST[Stake ceiling · martingale bounds]
    end

    G --> T --> S
    T --> R
    S --> FEED
    WS --> DIG
    REST --> DIG
    DIG --> SCAN --> SIG
    SIG --> BOT
    SIG --> AI
    BOT --> RISK
    AI --> RISK
    RISK --> WS
```

---

## Access flow

Only authorized operators pass the gate. Everyone else sees nothing.

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator
    participant App as Double LLS Traders
    participant Google as Google OAuth
    participant FS as Firebase Firestore
    participant Auth as TOTP verify

    Op->>App: Open desk
    App->>Google: Sign in (allowlisted email)
    Google-->>App: JWT credential
    alt First-time setup
        App->>FS: Store TOTP secret + hashed recovery codes
        App->>Op: QR scan + download recovery codes
    end
    Op->>Auth: 6-digit Authenticator code
    Auth-->>App: Verified session (8h TTL)
    App->>Op: Live feed + bot unlocked
```

---

## Capability map

```mermaid
%%{init: {'theme':'dark', 'themeVariables': {'pie1':'#00ff80','pie2':'#0a5c3a','pie3':'#043825','pie4':'#ffffff33','pie5':'#00ff8066'}}}%%
pie showData
    title Where the edge lives
    "Live digit analysis & cold-barrier math" : 30
    "Differs bot · bulk runs · take-profit" : 25
    "Security · OAuth · TOTP · recovery" : 20
    "AI operator · bankroll tracking" : 15
    "Backtest · Monte Carlo · edge scan" : 10
```

| Module | Depth |
|--------|-------|
| **Live feed** | Deriv Options API — OTP WebSocket + REST, real-time digit strips & tick chart |
| **Market scan** | Auto-ranks volatility indices; picks the best Differs payout surface |
| **Signal engine** | Multi-window votes, Wilson bounds, cold-gap timing, EV cushion vs break-even |
| **Differs bot** | Take-profit runs, bulk contracts, martingale recovery, deep-next gate |
| **AI operator** | Matches-side automation with bankroll discipline |
| **Backtester** | Offline tick replay + Monte Carlo stress paths |
| **Access gate** | Google identity → TOTP → session → lockout on brute force |

---

## Security stack

| Layer | Protection |
|--------|------------|
| **Identity** | Google OAuth — allowlisted emails only |
| **2FA** | Google Authenticator (TOTP, 30s window) |
| **Recovery** | 8 cryptographically random one-time codes (SHA-256 hashed in Firestore) |
| **Session** | 8-hour TTL, browser fingerprint binding, random session token |
| **Brute force** | 5 failed attempts → 15-minute lockout (per device) |
| **Secrets** | `.env` gitignored; never commit PATs or OAuth client secrets |
| **Firestore** | Rules scoped to `totp_secrets/{email}` for authorized operators only |

Full operator checklist → **[SECURITY.md](./SECURITY.md)**

---

## Quick start (local)

### 1 · Prerequisites

| Service | What you need |
|---------|----------------|
| **Deriv** | [Developer dashboard](https://developers.deriv.com/dashboard/) app ID (0% markup, Trade scope) |
| **Demo PAT** | [home.deriv.com → API tokens](https://home.deriv.com/dashboard/profile/api-tokens) with Trade scope |
| **Google OAuth** | Web client ID — see origins below |
| **Firebase** | Firestore enabled; publish [`firestore.rules`](./firestore.rules) |

**Google OAuth — Authorized JavaScript origins** *(no path)*

```
http://localhost:5173
https://doublellstraders.github.io
```

**Google OAuth — Authorized redirect URIs**

```
http://localhost:5173
https://doublellstraders.github.io/double-lls-traders/
```

### 2 · Configure

```bash
cp .env.example .env
# fill VITE_DERIV_*, VITE_GOOGLE_CLIENT_ID, VITE_FIREBASE_*
npm install
npm run check-auth
npm run dev
```

Open **http://localhost:5173/**

First login: **Google → scan Authenticator QR → download recovery codes → enter 6-digit code.**

---

## Deploy (GitHub Pages)

Workflow: [`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml) — runs on push to `master`.

Add **Actions secrets** mirroring `.env`:

| Secret | Required |
|--------|----------|
| `VITE_DERIV_APP_ID` | yes |
| `VITE_DERIV_TOKEN_DEMO` | yes |
| `VITE_DERIV_DEMO_ACCOUNT_ID` | recommended |
| `VITE_GOOGLE_CLIENT_ID` | yes |
| `VITE_FIREBASE_*` | yes (all Firebase web config vars) |
| `VITE_TRADING_MODE` | `live` or `paper` |

**Live URL:** https://doublellstraders.github.io/double-lls-traders/

---

## Operator scripts

```bash
npm run dev          # local desk
npm run build        # production bundle (Pages: GITHUB_PAGES=true npm run build)
npm run check-auth   # verify Deriv PAT + demo account
npm run backtest     # offline strategy replay
npm run find-edge    # scan indices for payout edge
npm run run-bot      # headless bot cycle (CLI)
```

---

## Safety defaults

- Demo account + **paper mode** for all development.
- Session caps: daily loss, consecutive losses, max stake — all in `.env`.
- **Never** paste tokens, recovery codes, or `.env` in chat or screenshots.
- Rotate Deriv PAT and recovery codes if exposure is suspected.

---

## Credits

<table>
<tr>
<td width="80"><img src="./logo-exports/logo-64-transparent.png" alt="LLS" width="64" /></td>
<td>

**Joseph Nyarandi** — architect & builder  
*Double LLS Traders* — institutional-grade digit desk for Deriv synthetic indices  

</td>
</tr>
</table>

---

## Disclaimer

For analysis and education only. **Not financial advice.** Synthetic index digits are uniformly random over time; no strategy guarantees profit. Trade only with funds you can afford to lose.
