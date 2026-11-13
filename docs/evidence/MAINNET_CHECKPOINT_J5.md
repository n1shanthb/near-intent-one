# Checkpoint J5 — Mainnet quote-to-transaction safety

**Broadcast / Ledger / unpause / funding / trusted-signer register:** NONE  
**Evidence JSON:** `MAINNET_CHECKPOINT_J5.json`  
**Tests:** `packages/mainnet/j5.quotePath.test.mjs` (9/9)

## 1. Real signed-quote verification

| Check | Result |
|-------|--------|
| Official SDK `verifyQuoteSignature` / `quoteHash` machinery (local signed responses) | **PASS** |
| Reject unsigned / amount-mutated / stale / request-mismatched | **PASS** |
| Live dry `/v0/quote` responses | **FAIL:unsigned_quote** (no `signature`/`timestamp`; observation economics only) |
| TLS certificate verification | Enabled (`rejectUnauthorized: true`) — never disabled |

**Finding:** Official `buildSignedQuote` hash covers request + amount fields only — **not** `depositAddress`. Escrow binding is enforced by `QUOTE_AUTH_V2` attestation + `tx.to == deposit`.

Attestation generation is **fail-closed**: no attestation unless 1Click verify PASSes (legacy Gate F may set `allowUnverifiedOneClick` only).

## 2. AI consumes quote-level data

`observe.mjs` + enriched `runFourChainQuoteMatrix` matrix inject `live_1click.quotes[]` with:

- source/destination chain + canonical `asset_id`
- quote/correlation ids + freshness
- raw amounts, decimals, amount out / min out / fees / USD
- capital/inventory availability
- net economics

Fixture/strategist path preserves **NO_TRADE** while paused / unfunded. See JSON `ai_quote_level_consume.ok`.

## 3. Quote → attestation → ERC-20 (local)

| Route | Verify | Attest | Escrow bind | Digest | Broadcast |
|-------|--------|--------|-------------|--------|-----------|
| EVM USDC → NEAR wNEAR | PASS (local signed) | PASS | PASS | PASS | **OFF** |
| EVM USDC → Arb USDC | PASS (local signed) | PASS | PASS | PASS | **OFF** |
| Manipulated amountOut | FAIL closed | — | — | — | OFF |

Policy sim rejects bad deposit `tx.to`, amount, chain_id, and replayed attestation ids.

## 4. Cross-chain decimals / risk

Contract uses **raw `amount_in`**, not USD.

| Route class | Safe for value/slippage/exposure? |
|-------------|-------------------------------------|
| USDC→USDC (6/6) | **Yes** (preferred first funded) |
| USDC→wNEAR (6/24) | **No** — slippage floor trivially loose |
| WETH→USDC (18/6) | **No** — false reject / unit mismatch |
| wNEAR→USDC (24/6) | **No** — false reject |

Fail closed. Do not broaden `token_scope`.

## 5. Trusted attestor architecture

Isolated ed25519 key; verify 1Click first; owner Ledger `add_trusted_signer` only after blockers clear. Rotation/revocation documented in `packages/mainnet/attestorDesign.mjs`. **Not registered on mainnet.**

## 6. Route readiness (four chains)

See JSON `route_readiness`. Funded execution: **false** everywhere. NEAR-origin funded execution: **not claimed**.

## 7. Blockers before first tiny funded trade

1. Verifiable funded (non-dry) 1Click signature **or** explicit owner residual-risk acceptance  
2. Register attestor (`add_trusted_signer`) via Ledger — not done  
3. Fund MPC `0xee82d632…7cd4` with gas + tiny USDC  
4. Prefer same-decimal USDC→USDC  
5. Prove NEP-141 before any NEAR-origin claim  
6. Owner unpause + funded_trading + broadcast gates  
7. Keep `autonomous=false`, `token_scope=allowlist`

## 8. Recommended next operator action

On a TLS-clean network: obtain one **non-executing** funded-shape quote response that includes `signature`+`timestamp`+`depositAddress`, verify it with the official SDK against the published manager key, and record PASS/FAIL — still **no** deposit, unpause, or attestor registration.
