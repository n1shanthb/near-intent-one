# Checkpoint J5.2 — Policy-compatible live quote search

**No funding / deposit / Ledger / attestor / unpause / broadcast**  
**Evidence:** `MAINNET_CHECKPOINT_J5_2.json` · SDK 0.1.26

## Hypothesis

`slippageTolerance=100` consumes the full on-chain 100 bps allowance; routing fees then push `minAmountOut` below floor `990000` (for 1 USDC). **Confirmed** on many slip=100 rows. Lower request slip (25–50) yields PASS.

## Matrix

Scanned **60** dry quotes · **25 PASS** · **35 BLOCKED**  
Dominant block reason: `min_out_below_policy_floor`.

## Recommended first tiny trade

| Field | Value |
|-------|-------|
| Route | **Arbitrum USDC → Base USDC** (`arb_usdc_to_base_usdc`) |
| Input | **1 USDC** (`1000000` raw) |
| Slippage requested | **25 bps** |
| Dry minAmountOut / floor | `994904` / `990000` → **PASS** |
| Signature (pinned manager) | **PASS** |
| Custody | MPC `0xee82d632…7cd4` (allowlisted) |

## Matching non-dry (no deposit)

| Field | Value |
|-------|-------|
| Signature verify | **PASS** |
| Policy status | **PASS** (unaltered values) |
| amountOut | `997398` |
| minAmountOut | `994904` (≥ floor `990000`) |
| Escrow | `0x37e38F078430e4E51c6Da63457beC7AE86Ca612e` |
| escrow_in_signed_hash | **true** |
| Fee USD est. | ~$0.0026 |
| Gas | L2 low · within `max_gas_budget` |
| Deposit sent | **false** |

## Also noted

Score-max dry was Base→Arb @ **5 USDC** / slip 25 (also PASS). First-tiny recommendation prefers **1 USDC** on L2.

Routes to Ethereum were generally weaker/BLOCKED for these sizes.

## Exact next operator action (J6)

**Review the J6 attestor-registration plan and approve separately before any Ledger `set_trusted_quote_signer` call.**

Do not fund, deposit, unpause, or broadcast until J6 + J7 are separately approved.
