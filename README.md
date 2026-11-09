# near-intent-one

NEAR-native hardware-governed AI trading agent.

**Novelty claim:** A policy contract—not the agent—controls an MPC-derived multichain signing key. Every intent is bound to a mandate epoch with reserved pending exposure. Revocation blocks new signatures immediately and quarantines outstanding intents until settlement or expiry.

Primary track: **Unstoppable DeFi** (Chain Signatures + NEAR Intents).

## Hard gate (Day 1)

1. Policy contract requests a Chain Signature under a **contract-owned** derivation path.
2. After `revoke()`, a new signature request is rejected on-chain.

```text
trading/v1/<mandate_epoch>
```

Testnet signer: `v1.signer-prod.testnet` (query live; do not hardcode the root key).

## Toolchain (E: only)

```powershell
$env:RUSTUP_HOME = "E:\toolchains\rustup"
$env:CARGO_HOME  = "E:\toolchains\cargo"
$env:Path        = "E:\toolchains\cargo\bin;$env:Path"
```

## Commands

```powershell
cd E:\near-intent-one\contracts\policy
cargo test
cargo test revoke
cargo test pending_exposure
```

## Layout

```text
contracts/policy/   # NEAR policy + MPC gate + pending exposure
packages/           # codec / verifier helpers
scripts/            # smoke / live verification (Gate F owned separately)
evidence/           # retained live proof artifacts
apps/web/           # product UI (cockpit, Copilot, Predict) — product lane only
docs/               # hackathon alignment + product isolation notes
```

## Product UI

```powershell
cd E:\near-intent-one\apps\web
npm install
npm run dev
```

Judge positioning: hardware sets rules → AI trades → NEAR enforces. See `apps/web/README.md` and `docs/PRODUCT.md`. Do not edit `contracts/` or `scripts/gate-*` from the product lane.
