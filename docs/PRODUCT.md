# Product UI — final integration notes

## Status

- Hardware ownership **VERIFIED** (H1) — separate from device **CONNECTED**
- H3 deterministic strategy **PASS** with real Sepolia/MPC/reconcile proofs
- Mandate **revoked @ epoch 19** after hardware revoke — no auto-unrevoke
- `/api/ledger-migrate` localhost-only; absent from production static deploy

## Run / deploy

See `apps/web/README.md`.

## Remaining unsupported

1. Per-user policy contracts from a random NEAR wallet  
2. LLM Policy Copilot (typed compiler only)  
3. Mainnet trading  
4. On-chain `evidence_hash` verification  
5. Historical Predict market feeds (illustrative only)  
6. Auto-funded trades from the UI  

## Screenshots / video

Record from Judge demo → Agent H3 → Evidence → Security Ledger proofs → optional Ledger wizard.
