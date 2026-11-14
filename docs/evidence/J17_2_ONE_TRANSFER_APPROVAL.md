# J17.2 — One-transfer approval package (PRE-SIGN)

**Scenario:** `DETERMINISTIC_TESTNET_ERC20_TRANSFER_NOT_INTENTS`  
**Not Intents settlement.** This package does **not** authorize quote-signer registration, MPC `request_signature`, or EVM broadcast.

## Verdict: **NO-GO_PENDING_OWNER_PREREQS**

## Funding (already complete — do not re-fund)

| Item | Value |
|------|-------|
| MPC | [`0x9a82c26b3d158cf4b657ab2a3ef9e5e6c2934d55`](https://sepolia.etherscan.io/address/0x9a82c26b3d158cf4b657ab2a3ef9e5e6c2934d55) |
| ETH | 20000000000000000 wei |
| Tidepool USDC | 2000000 raw |
| Evidence | `docs/evidence/J17_CLAIM_AND_FUND_MPC.json` |

## Unresolved pending (DO NOT CLEAR without authority)

| Field | Value |
|-------|-------|
| operation_id | `j16-mpc-6890` |
| amount_in | `1000000` |
| destination | `nio-owner-02b7cf.testnet` |
| signing_state | `Signed` |
| settlement_state | `None` |
| reserved | `1000000` / max `2000000` |
| headroom for next 1e6 | `1000000` (fits=true) |
| conflict | No ID/exposure conflict with next EVM transfer |
| action | **LEAVE IN PLACE** until reconcile or explicit owner clear |

Existing pending destination differs from next EVM recipient (no dest collision)

## One-transfer envelope (exactly one attempt)

| Field | Approved maximum |
|-------|------------------|
| chain_id | `11155111` (Sepolia) |
| token | `0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2` |
| destination | `0x70997970c51812dc3a010c7d01b50e0d17dc79c8` |
| amount | ≤ `1000000` raw (1.0 Tidepool USDC) |
| gas | fresh `eth_estimateGas` + 20% headroom; abs max 400000; policy `max_gas_budget` |
| attempts | **exactly 1** |

Fresh gas this check: estimate 141972 → limit 170366  
Historical 142k fallback: **REFUSED** (`historical_gas_estimate_never_satisfies_readiness`).

## Attestor

| Check | Result |
|-------|--------|
| Expected pk | `ed25519:FpYz8GbzcFDmmHcFVffnVSJfroguqZVudNU6yt6Wuozh` |
| Local seed derives expected | **PASS** |
| On-policy trusted | **false** |
| Seed gitignored | yes (`.gate-i-data/`, `**/attestor*.seed.json`) |

### Post-test signer revocation plan

1. Owner call clear/unset trusted quote signer on j16f6890.testnet (or set_trusted_quote_signer to a new rotated key)
1. Rotate local .gate-i-data/attestor.seed.json offline; never commit the seed
1. Confirm is_trusted_quote_signer(old_pk) === false before discarding revocation evidence
1. Do not reuse the disposable J16 attestor key on mainnet

## Dual owner authorizations (separate)

1. **Register quote signer** (not this run): set `J17_QUOTE_SIGNER_REGISTER_AUTHORIZED=1` then owner calls `set_trusted_quote_signer({ public_key: "ed25519:FpYz8GbzcFDmmHcFVffnVSJfroguqZVudNU6yt6Wuozh" })` on `j16f6890.testnet`.
2. **MPC sign + broadcast** (not this run): after journal secret is provisioned and signer registered, set `J17_MPC_SIGN_BROADCAST_AUTHORIZED=1` and run `npm run j17:mpc-broadcast`.  
   `J17_SEPOLIA_FUNDING_AUTHORIZED` alone **does not** authorize signing.

## Journal secret

- Provision once per `docs/evidence/J17_2_JOURNAL_SECRET_PROVISIONING.md`
- Never print, commit, or regenerate on crash recovery
- Status this run: **MISSING — NIO_TX_JOURNAL_SECRET_required_no_predictable_fallback**

## Pre-sign persistence (required before MPC)

Before `request_signature`, durable record must lock: operation_id, epoch, amount, destination, nonce, digest, signing_intent. Recovery resumes that operation — never duplicates propose.

## Gates

```
{
  "FUNDING_CONFIRMED": "PASS",
  "PENDING_CONFLICT_SAFE": "PASS",
  "CONTRACT_ABI_MATCH": "PASS",
  "GAS_ESTIMATION_FAIL_CLOSED": "PASS",
  "ATTESTOR_KEY_VERIFIED": "PASS",
  "JOURNAL_PROVISION_DOCUMENTED": "PASS",
  "JOURNAL_AND_REPLAY_SAFE": "FAIL",
  "ONE_TRANSFER_BOUNDARY": "PASS",
  "POLICY_STATE_VERIFIED": "PASS",
  "DUAL_AUTH_GATES_DEFINED": "PASS",
  "PRE_SIGN_SAFE": "NO-GO_PENDING_OWNER_PREREQS",
  "MAINNET_AUTONOMY_READY": "NO-GO"
}
```

## HARD STOP

No signer registration, MPC signing, broadcast, funding, or mainnet mutations were performed in J17.2.
