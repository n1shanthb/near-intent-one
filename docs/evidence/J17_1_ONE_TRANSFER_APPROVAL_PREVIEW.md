# J17.1 — One-transfer approval preview

**Scenario:** `DETERMINISTIC_TESTNET_ERC20_TRANSFER_NOT_INTENTS`  
**Not Intents settlement.** Hard stop: this preview does **not** authorize MPC `request_signature` or EVM broadcast.

## Funding (already done)

| Item | Value |
|------|-------|
| MPC | [`0x9a82c26b3d158cf4b657ab2a3ef9e5e6c2934d55`](https://sepolia.etherscan.io/address/0x9a82c26b3d158cf4b657ab2a3ef9e5e6c2934d55) |
| ETH | 20000000000000000 wei |
| Tidepool USDC | 2000000 raw |
| Evidence | `docs/evidence/J17_CLAIM_AND_FUND_MPC.json` |

## Policy (live views)

| View | Value |
|------|-------|
| paused | false |
| revoked | false |
| mandate_epoch | 2 |
| autonomous_trading | true |
| enforce_autonomous | true |
| derivation_path | trading/v1/portfolio/j16-mpc-6890 |
| reserved_pending | 1000000 |

## Planned transfer

| Field | Value |
|-------|-------|
| operation_id | `j17-1-ec65c0` |
| method | `propose_quoted_evm_transfer` then `request_signature({ operation_id })` + **1 yoctoNEAR** |
| token | `0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2` |
| from | `0x9a82c26b3d158cf4b657ab2a3ef9e5e6c2934d55` |
| to | `0x70997970c51812dc3a010c7d01b50e0d17dc79c8` (allowlisted test recipient) |
| amount | `1000000` (1.0 USDC) |
| chain_id | `11155111` |
| nonce | `0` (fresh) |
| gas_price | `1000000000` wei |
| gas_limit | `170366` (estimate 141972 + headroom; policy-bounded) |
| digest | `7368a2f9f8a2c6705b2184e0419ce2e1564fad65b93075a9df4e5f3382c02581` |
| expected_epoch | `2` |

## ABI notes

- `request_signature` accepts **`operation_id` only**; payload is the reserved digest.
- **No** `propose_trade` fallback for `0x` destinations.
- **No** `get_state` — use real views listed above.
- Journal requires `NIO_TX_JOURNAL_SECRET` (no predictable fallback).

## Owner prereqs before broadcast approval

1. Owner call `set_trusted_quote_signer({ public_key: "ed25519:FpYz8GbzcFDmmHcFVffnVSJfroguqZVudNU6yt6Wuozh" })` on `j16f6890.testnet`.
2. Set `NIO_TX_JOURNAL_SECRET` (≥32 chars) in the execution environment.
3. Separate explicit approval to set `J17_SEPOLIA_FUNDING_AUTHORIZED=1` and run broadcast (not this run).

## Gates

```
{
  "FUNDING_CONFIRMED": "PASS",
  "CONTRACT_ABI_MATCH": "PASS",
  "SIGNATURE_DEPOSIT_CORRECT": "PASS",
  "DIGEST_BINDING_VALID": "PASS",
  "GAS_ESTIMATION_VALID": "PASS",
  "POLICY_STATE_VERIFIED": "PASS",
  "JOURNAL_AND_REPLAY_SAFE": "FAIL",
  "PRE_BROADCAST_READY": "READY_PENDING_OWNER_PREREQS",
  "MAINNET_AUTONOMY_READY": "NO-GO"
}
```
