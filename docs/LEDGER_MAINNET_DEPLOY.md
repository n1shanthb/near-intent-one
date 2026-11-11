# Ledger-controlled mainnet policy deploy (approval-ready estimate)

**Status:** Estimate only — **no account created, no funds spent, no deploy, no signing**  
**Date:** 2026-11-11  
**Network:** NEAR mainnet  
**Signer intent:** Physical Ledger (operator has not yet created a mainnet account)

## Recommended account layout

| Role | Account | Notes |
|------|---------|-------|
| Operator / owner (Ledger) | `<you>.near` | Create via Ledger + official NEAR wallet / CLI; keep full-access on device |
| Policy contract (subaccount) | `policy.<you>.near` | Preferred — created by owner, code deployed once |
| Agent (hot, limited) | `agent.<you>.near` or separate | Only agent role in policy; never owner keys |

Do **not** use a top-level `*.near` name that requires registrar/parent you do not control. A contract subaccount under the Ledger owner is feasible and preferred.

Avoid `nio-c-*` demo prefixes on mainnet.

## Artifact (do not deploy older)

| Field | Value |
|-------|-------|
| Path | `artifacts/mainnet/policy.wasm` |
| Bytes | **625701** |
| SHA-256 | **f8e51e444557e702929a497c1e93fc50ca3232d1d7dd64f1b04c995f4f565fb0** |
| Supersedes | `aa301524…0202` (625565), `6fd1912f…30d1` (624900), earlier hashes |

This build: `any_eligible_token` blocked on EVM sign; **`max_gas_budget == 0` rejected** (not unlimited); recipient/refund allowlist; malicious-agent binding tests.

## Protocol storage (live mainnet `EXPERIMENTAL_protocol_config`)

| Parameter | Value |
|-----------|-------|
| `storage_amount_per_byte` | `10000000000000000000` yocto (0.00001 NEAR / byte) |
| WASM storage collateral | `625701 × 1e19` = **6.25701 NEAR** |

Gas action costs from the same config are << 0.01 NEAR for create/deploy/add_key and are covered by the buffers below.

## Approval-ready NEAR budget (not a transaction)

| Line item | NEAR |
|-----------|------|
| WASM / code storage | 6.25701 |
| Account creation buffer | 0.10 |
| Contract state buffer | 0.50 |
| Keys buffer | 0.05 |
| Gas fees buffer | 0.05 |
| Operating balance (views + rare owner calls) | 1.00 |
| **Recommended minimum** | **≈ 7.96 NEAR** |
| **Suggested approval ceiling** | **9 NEAR** |

Funded trading inventory (USDC etc.) is **separate** and must not be mixed into this deploy budget.

## Operator workflow (after explicit approval)

1. Create Ledger-owned `<you>.near` on mainnet (no NIO automation).
2. Confirm approval JSON: target `policy.<you>.near`, wasm sha256 above, `max_near ≥ 9`, `approved: true`.
3. Create subaccount + deploy WASM + `new(...)` with `mpc_signer = v1.signer`, `token_scope = allowlist`.
4. Keep `NIO_MAINNET_ALLOW_SIGN=0` and `NIO_MAINNET_ALLOW_FUNDED_QUOTE` unset until a separate funded canary approval.
5. Never enable `any_eligible_token` for funded EVM execution until risk/destination enforcement is proven beyond the current hard block.

## Explicit non-actions (this document)

- No funded transfers  
- No account creation by automation  
- No Ledger signing requests  
- No mainnet deploy broadcast  
