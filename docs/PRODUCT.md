# Product UI guide

## Run

```powershell
cd E:\near-intent-one\apps\web
npm install
npm run dev
```

Open http://localhost:5173 — starts on **Judge demo**.

## Data modes

| Mode | Meaning |
|------|---------|
| Recorded verified evidence | Gates B–G hashes / F4 execution / G accounting snapshot |
| Illustrative simulation | Predict only — never labeled VERIFIED |
| Current live reads | Read-only RPC + Tidepool dry quotes |

## F4 / G in the UI

- Sepolia: `0xe49d5ff80fd8533d9719969b50647e49c99845d79fac27d39578e4003552e558`
- NEAR settlement: `B6uEASppdZmHM25RxiF5U9rs3K98eEkPj77Z8JhGcKfY`
- Gate G: reserved `0`, unresolved `0`, `economically_settled=true`
- Ledger: **NOT CONNECTED / NOT PROVEN** until Gate H

## Gate H adapters

`apps/web/src/adapters/gateh.ts` — Ledger proven flag + strategy decision log (null until real).

## Tests

```powershell
npm test
npm run build
```
