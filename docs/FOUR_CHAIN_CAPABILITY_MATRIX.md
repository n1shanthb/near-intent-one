# Four-chain capability matrix (honest)

**Updated:** 2026-11-11  
**Rule:** Distinguish tests / implementations / on-chain proofs. No fabricated explorer links.

Networks preserved as identities: **NEAR**, **Ethereum (eip155:1)**, **Arbitrum (42161)**, **Base (8453)**.

| Capability | NEAR | Arbitrum | Base | Ethereum | Label |
|------------|------|----------|------|----------|-------|
| Network identity in mandate `allowed_chains` | yes | yes | yes | yes | IMPLEMENTED |
| Mainnet RPC / public reads used in tooling | yes | config default | identity only | identity + token id | VERIFIED ON MAINNET (NEAR MPC + 1Click registry); EVM RPCs configured, not required for this sprint proof |
| Live production token registry | via 1Click | arb USDC id present | base USDC id in adapter | eth USDC id present | VERIFIED ON MAINNET (229 tokens) |
| Live dry quote | 1Click dest `wrap.near` | origin arb USDC → wNEAR | not exercised this sprint | not exercised this sprint | **DRY_QUOTE_OBTAINED** (arb USDC → wNEAR) |
| Deployed policy contract | — | — | — | — | **NOT YET PROVEN** |
| MPC `v1.signer` root key read | yes | derived EVM addr for canary path | — | — | VERIFIED ON MAINNET (read / derive only) |
| Tested signing logic (unit) | intent + quoted EVM digest bind | ERC-20 transfer digest | chain id allowlist | chain id allowlist | IMPLEMENTED + unit tested |
| Funded settlement | no | no | no | no | **NOT YET PROVEN** |

## Routes

| Route adapter | Status | Executable now? |
|---------------|--------|-----------------|
| `near_intents_1click` | Production dry-quote + bind/validate/status helpers | **Dry quote yes**; deposit/sign/broadcast **no** (gates OFF) |
| `evm_0x` | Stub | No — `UNSUPPORTED_ROUTE` |
| `near_native_dex` | Stub | No — `UNSUPPORTED_ROUTE` |

## Policy security (mandate → MPC)

| Binding | Enforced on-chain in `propose_quoted_evm_transfer` / `request_signature` |
|---------|--------------------------------------------------------------------------|
| EVM chain ID | yes (`tx.chain_id` == attestation; `allowed_chains`) |
| Source token | yes (`tx.token` == attestation; asset allowlist) |
| Transfer recipient (deposit) | yes (`tx.to` == attested deposit; ERC-20 `transfer(deposit, amount)` digest) |
| Max input amount | yes (`max_trade_value`, exposure) |
| Quote / swap intent | yes (QUOTE_AUTH_V2 ed25519 + correlation/quote_hash) |
| Mandate epoch | yes |
| Expiry | yes (`quote_deadline_ns`) |
| Replay protection | yes (attestation id consumed) |
| Gas budget | yes (`max_gas_price * gas_limit` ≤ `max_gas_budget` when budget > 0) |
| Payload digest | yes (contract-computed EIP-155; `request_signature` signs stored commitment only) |
| Final recipient / refund | yes (mandate `allowed_destinations`) |
| `any_eligible_token` on EVM sign | **hard-blocked** (`any_eligible_token_not_safe_for_evm_sign`) |
| Backend bypass | Agent calling contract directly still hits the same checks (unit-tested) |

**ANY_ELIGIBLE_TOKEN:** not safe for funded EVM execution.

## Funded autonomous trading

**Not operational.** One production dry route works; stubs are labeled stubs; contract not deployed; signing/broadcast gates remain OFF.
