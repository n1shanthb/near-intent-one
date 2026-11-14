# J18 Phase 2 — Exact owner authorization for quote-signer registration

**STOPPED for separate explicit owner authorization.**  
This engineering prompt and any env flag alone are **not** approval to send the transaction.

## Live verification (read-only)

| Check | Result |
|-------|--------|
| Local seed derives expected pk | **PASS** |
| Expected pk | `ed25519:FpYz8GbzcFDmmHcFVffnVSJfroguqZVudNU6yt6Wuozh` |
| Policy | `j16f6890.testnet` |
| Owner | `nio-owner-02b7cf.testnet` |
| `is_trusted_quote_signer` | **false** (registration required) |
| Mainnet mutation | **none** |

## Exact transaction to authorize

| Field | Value |
|-------|-------|
| network | `testnet` only |
| contract | `j16f6890.testnet` |
| actor | `nio-owner-02b7cf.testnet` |
| method | `set_trusted_quote_signer` |
| args | `{ "public_key": "ed25519:FpYz8GbzcFDmmHcFVffnVSJfroguqZVudNU6yt6Wuozh" }` |
| deposit | `0` |
| verify after | `is_trusted_quote_signer` → `true` + NEAR receipt |

## Owner approval command (only after you explicitly approve THIS transaction)

```powershell
$env:NIO_TX_JOURNAL_SECRET_PATH = (Resolve-Path .nio-secure\j17\journal.secret).Path
$env:J17_QUOTE_SIGNER_REGISTER_AUTHORIZED = "1"
npm run j17:register-quote-signer
```

Then: fresh `npm run j17:presign-check` expecting sole remaining blocker cleared → **J18_TESTNET_PRE_SIGN_GO**.

## Not authorized in this run

- No `set_trusted_quote_signer` sent
- No MPC `request_signature`
- No Sepolia broadcast
- No mainnet changes
