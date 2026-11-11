# NIO — Mainnet MVP frontend

**Date:** 2026-11-11  
**URL:** https://near-intent-one.vercel.app  
**Deploy:** `dpl_9pPiT3ZTScJW3nAULRhCt2v35LcJ` (READY)  
**Active demo network:** NEAR **testnet** (from `/v1/health`)  
**Tests:** web vitest 48/48 · production build PASS

## What shipped

- Real network indicator from API health + verified evidence (not a cosmetic toggle)
- `/mainnet` Mainnet evidence view with capability matrix
- Overview + Evidence prominent mainnet proof banners (honest awaiting state)
- Explorer helpers that refuse testnet↔mainnet mismatches
- Owner-auth note: testnet session ≠ mainnet authentication
- Mainnet trading button disabled; public BFF allowlists unchanged

## Actual mainnet proof displayed

**None yet.** `MAINNET_EVIDENCE` remains unverified (`contract_deployed=false`, no account/tx). UI shows **AWAITING CHAT 1** until independently verified deployment evidence is supplied.

## Remaining blockers (Chat 1)

1. Verified mainnet policy/contract account + deploy tx  
2. Policy-active proof + MPC signer readiness  
3. Production Intents quote integration status  
4. Optional funded settlement proof  
5. Exact owner-only mainnet trading endpoint contracts / security gates  

## Unauthorized transactions

Confirmed none: no mainnet funded trades, no Gate K sign enablement, no public execution routes added.
