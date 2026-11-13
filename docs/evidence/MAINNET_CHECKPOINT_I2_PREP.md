# Checkpoint I2 — set_policy custody destinations (PREP ONLY)

**Broadcast:** NOT performed  
**Readiness:** PASS for operator Ledger review

## MPC derivation

- predecessor `policy.nishanthb.near`
- path `trading/v1/portfolio/nio-mainnet-v1`
- `v1.signer` domain `0`
- address `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` — **PASS**

## Diff (only change)

`allowed_destinations`:

- before: `["nishanthb.near"]`
- after: `["nishanthb.near", "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4"]`

All other limits fields unchanged. `mandate_epoch` will become **2**.

## Hashes

| Field | Value | Provenance |
|-------|-------|------------|
| policy_hash | `035f0de7f84aeb9d9147d040c38272e0f71e8181cce5ef6def7fff9c18d2712d` | SHA-256 of `nio:mainnet:policy_limits:v1` + canonical AFTER limits JSON |
| strategy_hash | `3625d48386d49c53b5cfec724a1e97d6f4f7b39fb4f2940a8ba6f9fd1f07c794` | SHA-256 of reviewed four-chain `DEMO_ROUTES` artifact (no fabricated thesis) |

## Local args file (outside repo)

`%USERPROFILE%\.nio-secure\mainnet-i2\set_policy_args.json`

Funded execution remains OFF; contract stays paused; no unpause / autonomous / agent / EVM funding in this step.
