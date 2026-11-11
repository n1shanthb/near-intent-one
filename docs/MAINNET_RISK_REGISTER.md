# Mainnet risk register

**Date:** 2026-11-11 · Pre-funded canary

| ID | Risk | Severity | Mitigation | Status |
|----|------|----------|------------|--------|
| R1 | Mixing testnet/mainnet keys, paths, or Tidepool with 1Click | Critical | Separate profiles + credentials dirs; mainnet bans Tidepool sandbox | Mitigated in code |
| R2 | Accidental funded sign/broadcast | Critical | All `NIO_MAINNET_ALLOW_*` default OFF; deploy script refuses broadcast without dual gates | Mitigated |
| R3 | Acceptance override to force a live trade | Critical | Explicitly forbidden; AI REJECT → BLOCKED | Mitigated |
| R4 | Demo `nio-c-*` reused on mainnet | High | Banned in deploy/init/derive/canary | Mitigated |
| R5 | Claiming derived MPC address as signature proof | High | Status label `DERIVED_ADDRESS_ONLY` | Process |
| R6 | Deploying wrong WASM | High | sha256 must match approval file | Mitigated |
| R7 | Overspend on contract deploy storage | High | `max_near` hard check in approval | Awaiting your cap |
| R8 | OCI E2.1.Micro OOM during settlement | High | Do not host unrestricted mainnet worker on micro; keep demo on testnet OCI | Open — need approved host |
| R9 | 1Click JWT missing / WAF blocks non-browser clients | Medium | Env-only `NIO_1CLICK_JWT`; dry quotes fail closed; registry verified independently | Open (JWT + quote still needed) |
| R10 | Asset ID mismatch (Sepolia USDC ≠ prod USDC) | High | Live `/v0/tokens` registry required before fund | Open |
| R11 | Contract deployed but not Ledger-owned | High | Evidence distinguishes DEPLOYED vs Ledger mandate | Process |
| R12 | Failed/unsettled testnet lifecycle | High | Canary readiness blocks until testnet recoverable | Open |
| R13 | Withdrawal/refund unproven on mainnet | High | Owner withdraw path exists in WASM; mainnet receipt still NOT YET PROVEN | Open |
| R14 | Public judge demo breakage | High | api-server hard-requires testnet; mainnet tooling separate | Mitigated |

## Blockers to funded mainnet canary

1. Your approval of deploy account + WASM hash + max NEAR  
2. Confirmed mainnet policy deploy + view verification  
3. Ledger NEP-413 owner session on mainnet account  
4. Production 1Click JWT + dry quote on real asset IDs  
5. Recoverable testnet settlement lifecycle evidence  
6. Separate canary approval (amounts, addresses, purpose)  
7. Explicit `NIO_MAINNET_ALLOW_SIGN=1` for that trial only  
8. Non-micro or carefully isolated settlement host (no purchase without permission)
