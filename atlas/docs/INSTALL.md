# Atlas installation

## Prerequisites

- Node 20+
- Python 3.11+
- Deriv app id + demo token in repo `.env` (`VITE_DERIV_APP_ID`, `VITE_DERIV_TOKEN_DEMO`)
- Optional: Docker

## 1. Main app (Digits + Atlas switch)

```bash
npm install
npm run dev
```

Open Settings → Hub → choose Atlas (or rename it).

## 2. Atlas API

```bash
cd atlas/api
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8787
```

The Atlas dashboard probes `http://127.0.0.1:8787/health` and shows API online/offline. Charts and signals work **without** the API (browser Deriv client).

## 3. Docker

From `atlas/`:

```bash
docker compose up --build
```

- API: `localhost:8787`
- Postgres: `localhost:5433` (reserved for Phase 2 persistence)
- Redis: `localhost:6380` (reserved for Phase 2 jobs)

## 4. Smoke test

```bash
npm run atlas:smoke
```

## Risk defaults

| Gate | Default |
|------|---------|
| Risk per trade | 1% equity |
| Daily loss limit | 3% |
| Max open trades | 2 |
| Max consecutive losses | 4 |
| Max daily trades | 20 |
| Paper mode | on |

## Security notes

- Do not commit live tokens
- V1 paper execution only — live CFD order routing is Phase 2
- Hub switch refuses to change while a paper trade is marked open
