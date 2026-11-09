# Agent backend integration contract (Gate H4)

Product UI (`apps/web`) should consume these types from `packages/agent-api/types.ts`.  
Do not invent decision traces, Ledger proofs, or settlement hashes in the frontend.

## Accounts (testnet)

| Role | Account |
|------|---------|
| Owner | `nio-c-owner-857107.testnet` |
| Agent | `nio-c-agent-857107.testnet` |
| Policy contract | `nio-c-policy-857107.testnet` |
| Reconciler | separate account after Gate H2 (not the trading agent) |

## View methods (NEAR)

| Method | Returns |
|--------|---------|
| `get_mandate_epoch` | `u64` |
| `get_exposure_snapshot` | `ExposureSnapshot` |
| `get_revocation_status` | `RevocationStatus` |
| `get_reconciler` | `AccountId \| null` |
| `get_pending` / `list_pending` | pending ops |
| `get_evidence_hash` | stored pointer only |

## Mutation boundaries

| Method | Who |
|--------|-----|
| `set_policy`, `revoke`, `unrevoke`, `set_reconciler`, `set_trusted_quote_signer` | **owner** (Ledger-preferred) |
| `propose_quoted_evm_transfer`, `request_signature` | **agent** |
| `reconcile_pending` | **owner** or **reconciler** |
| Contract `DeployContract` | whoever holds contract-account **FullAccess** (upgrade authority) |

## Decision records

Written by `packages/strategy/decide.mjs` → `evidence/live/gate-h-decision.json`.  
Shape: `AgentDecisionRecord` (`TRADE` \| `NO_TRADE` + rationale + checks).

## Quote authorization

`QUOTE_AUTH_V2` via owner-pinned attestor (`trusted_attestor_not_tidepool_maker`).  
Tidepool maker signatures are **not** independently verified on-chain.

## Settlement / reconcile

Off-chain watchdog: `packages/reconcile/verify-settlement.mjs`  
Must verify origin receipt + Tidepool terminal **before** `reconcile_pending`.  
Contract stores `evidence_hash` with `verified_onchain:false`.

## Ledger state

Until physical proof: `LedgerConnectionState.status = "BLOCKED"`.  
Never treat software FullAccess as hardware-proven.

## Evidence files

| File | Content |
|------|---------|
| `evidence/live/gate-h-evidence.json` | Full Gate H run |
| `evidence/live/gate-h-decision.json` | Latest strategy decision |
| `GATE_H.md` | Human verdicts |
