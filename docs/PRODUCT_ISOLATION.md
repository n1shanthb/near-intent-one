# Product lane isolation

Date: 2026-11-09

## Worktree status

Requested: `E:\near-intent-one-product` on branch `feat/product-ui`.

**Blocked:** `E:\near-intent-one` has **no `.git` directory**, so `git worktree add` cannot be created safely without initializing a new repository (which would risk colliding with the parallel Gate F chat’s uncommitted contract/script work).

**Mitigation:** All product work stays under:

- `apps/web/**` — single frontend (no second app)
- `docs/PRODUCT*.md`, `docs/HACKATHON_ALIGNMENT.md`
- `worktrees/product/.agents/skills/**` — NEAR agent skills only

## Hard exclude list (do not edit from product lane)

- `contracts/`
- `scripts/gate-*`
- `evidence/`, `EVIDENCE.md`, `DECISION.md`
- Gate F signing / attestor modules under `packages/intents-codec/` (read-only for types)

## Modes

| Mode | Meaning |
|------|---------|
| `verified` | Hashes and outcomes from completed Gates B–E evidence |
| `simulation` | Labeled Predict / illustrative scenarios — not live fills |
| `live` | Read-only RPC / dry quotes; no funded trades from this UI |

## Gate F handoff

See `apps/web/src/adapters/gatef.ts` and `docs/GATE_F_INTEGRATION.md`.
