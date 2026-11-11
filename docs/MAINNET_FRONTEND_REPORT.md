# NIO — Mainnet / four-chain frontend

**Date:** 2026-11-11  
**URL:** https://near-intent-one.vercel.app  
**Deploy:** `dpl_12auNNxBvbFRoAJyVKhNYyaaeEet` (READY)  
**Active demo network:** NEAR **testnet** (public BFF unchanged)  
**Tests:** web vitest **48/48** · production build **PASS**

## What shipped

- Four-chain portfolio panel (NEAR / Arbitrum / Base / Ethereum) with **UNVERIFIED BALANCES** — no fake USD
- Canonical asset selector (`eip155:…` / `nep141:…` / `native:…`) — disabled without owner signing
- Mandate Mode A (ANY_ELIGIBLE_TOKEN, explicit checkbox) vs Mode B (ALLOWLIST default) + four-chain toggles
- Agent **route selection** panel (source/dest/gas/fees/Fitter·Critic) with **NO LIVE QUOTE**
- Transactions source → dest → reconcile columns (testnet proofs labeled as such)
- Mainnet Evidence **per-network** awaiting matrix + explorers named, links only when Chat 1 supplies ids
- Owner-only mainnet trade button remains **disabled**

## Screenshots (production)

| Page | URL |
|------|-----|
| Portfolio | https://near-intent-one.vercel.app/portfolio |
| Mandate | https://near-intent-one.vercel.app/mandate |
| Agent | https://near-intent-one.vercel.app/agent |
| Mainnet evidence | https://near-intent-one.vercel.app/mainnet |

## Actual mainnet proof displayed

**None.** `MAINNET_EVIDENCE` still awaiting Chat 1 (`contract_deployed=false`). UI shows **AWAITING CHAT 1 PROOF**.

## Architecture / policy (Chat 1)

See `docs/OPEN_UNIVERSE_ARCHITECTURE.md`.  
New policy WASM (not deployed): sha256 `6fd1912f5912f52481f788ee0a4f7fec1cbc3cafd34496d53e61feb59c1a30d1`.

## Remaining blockers

1. Creatable mainnet target account + deployer/owner/agent  
2. Operator approval of new WASM hash + max NEAR  
3. Verified live balances / dry quotes per chain  
4. 0x + NEAR-native DEX adapters (stubs only)  
5. Funded mainnet signing stays **OFF**

## Unauthorized transactions

Confirmed none: no mainnet fund/sign/broadcast; public BFF allowlists unchanged; `may_sign=false` on Live AI.
