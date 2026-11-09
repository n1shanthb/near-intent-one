# near-intent-one — product UI

Judge-facing autonomous trading control center (product lane only).

## Positioning

**Your hardware wallet sets the rules. Your AI trades across chains. NEAR enforces the boundaries.**

Tracks: `defi`, `security`, `agents`.

## Run

```powershell
cd E:\near-intent-one\apps\web
npm install
npm run dev
```

Build / test:

```powershell
npm run build
npm test
```

## Data modes

| Mode | Behavior |
|------|----------|
| Recorded verified evidence | Gates B–G · F4 unattended settle · G accounting (default) |
| Illustrative simulation | Predict only — never VERIFIED P/L |
| Current live reads | NEAR views + Tidepool `dry:true` via Vite proxy |

Primary proofs: Sepolia `0xe49d5ff8…` · NEAR `B6uEASpp…`. Ledger remains **NOT PROVEN**.

This UI does **not** submit funded trades.

## Isolation

See `docs/PRODUCT_ISOLATION.md`. Git worktree at `E:\near-intent-one-product` was blocked (repo has no `.git`). Product edits stay in `apps/web` + product docs.

Gate F adapters: `src/adapters/gatef.ts`, `docs/GATE_F_INTEGRATION.md`.
