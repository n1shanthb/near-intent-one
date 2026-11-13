# Checkpoint J5.1 — Live quote verification + evidence correction

**Broadcast / Ledger / unpause / funding / deposit / attestor register:** NONE  
**SDK:** `@defuse-protocol/one-click-sdk-typescript@0.1.26`  
**Evidence JSON:** `MAINNET_CHECKPOINT_J5.json`

## 1. Real dry quote signature verification

**PASS**

Authentic `OneClickQuoteResponse` preserved (`quoteRequest`, `quote`, `signature`, `timestamp`, `correlationId`). Verified with pinned manager key `ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc` before normalization.

## 2. Real non-dry signature verification

**PASS** (no deposit sent)

## 3. SDK signature field coverage (0.1.26)

- Dry: amounts only
- Non-dry: amounts + `depositAddress`, `depositMemo`, `deadline`, `timeWhenInactive`, `timeEstimate`, fees
- Request: assets, amount, recipient, refundTo, dry, …

(0.1.24 omitted escrow from hash; docs require >=0.1.26.)

## 4. Escrow authenticity

**PASS** — attestor signature alone is never treated as 1Click escrow proof.

## 5. Live USDC→USDC min-out vs deployed policy

On-chain `max_slippage_bps`: **100**  
Live result: **BLOCKED** (values unaltered)

| Kind | Result |
|------|--------|
| Live authorization | BLOCKED_BY_POLICY_SLIPPAGE_FLOOR |
| Fixture authorization | PASS (FIXTURE ONLY) |

## 6. Next readiness

Do not proceed to funded trading until live quote, escrow signed-hash coverage, attestor (`set_trusted_quote_signer`), and policy floor all PASS without altered values.
