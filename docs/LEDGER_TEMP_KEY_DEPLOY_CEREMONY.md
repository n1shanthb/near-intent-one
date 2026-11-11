# Ledger + temporary deploy-key ceremony (testnet rehearsal → mainnet)

**Status:** Testnet software-key rehearsal **PASS** on dedicated account. Ledger device signing **not exercised** this session (swap `sign-with-legacy-keychain` → `sign-with-ledger` / `use-ledger` when device present).  
**Mainnet broadcast: NOT executed.**  
**Funded trading during temp-key window: FORBIDDEN.**

## CLI

| Field | Value |
|-------|-------|
| Binary | `near-cli-rs` **0.31.1** (GitHub release `near-cli-rs-x86_64-pc-windows-msvc`) |
| Install (this workstation) | Extract release tarball → `~/bin/near-cli-rs/.../near.exe` |
| Credentials | Legacy keychain: `%USERPROFILE%\.near-credentials\testnet\` |

`delete-key` is **not** a subcommand — use `account delete-keys public-keys`.  
`create-account fund-myself` **requires** `[INITIAL_BALANCE]` (e.g. `'3 NEAR'`).  
Owner-only calls need **`sign-as <owner>`**.

## Final artifact (inert)

| Field | Value |
|-------|-------|
| Path | `artifacts/mainnet/policy.wasm` |
| Bytes | **625701** |
| SHA-256 | **`3bc7c1120a1f593a4c96ff58171ce9521f780ceec0427d97f90f0cac9ecc4f90`** |
| On-chain code hash (rehearsal) | `52MidcEUUwVaiNcTtuQbKd1xwVQR8HGer4quihZj8FZZ` |
| Init | `paused=true` |

## Do not overwrite live policy

Existing `policy.nio-i-a4e7-a-owner.testnet` already has initialized state. Rehearse on a **new** child only.

## Testnet rehearsal — tested commands (`near-cli-rs` 0.31.1)

Replace `<OWNER>`, `<CHILD>`, `<TEMP_PK>`, `<INIT.json>` as needed. Ledger variant shown in comments.

```bash
# 0) Version
near --version
# near-cli-rs 0.31.1

# 1) Create Ledger-owned child (software rehearsal used autogenerate + legacy keychain)
near account create-account fund-myself <CHILD>.testnet '3 NEAR' \
  autogenerate-new-keypair save-to-legacy-keychain \
  sign-as <OWNER>.testnet network-config testnet sign-with-legacy-keychain send
# Ledger:
# near account create-account fund-myself <CHILD>.testnet '3 NEAR' \
#   use-ledger usb sign-as <OWNER>.testnet network-config testnet sign-with-ledger send

# 2) Confirm FullAccess on child
near account list-keys <CHILD>.testnet network-config testnet now

# 3) Temp FullAccess on POLICY child only (never commit the key)
near account add-key <CHILD>.testnet grant-full-access \
  autogenerate-new-keypair save-to-legacy-keychain \
  network-config testnet sign-with-legacy-keychain send
# → note TEMP_PK from output / key file under ~/.near-credentials/testnet/<CHILD>/

# 4) Fund storage for ~625KB WASM (needs ≥ ~4.2 Ⓝ liquid on child after fees)
near tokens <FUNDER>.testnet send-near <CHILD>.testnet '3 NEAR' \
  network-config testnet sign-with-legacy-keychain send

# 5) Deploy + init paused (signed by TEMP key file — NOT Ledger)
near contract deploy <CHILD>.testnet \
  use-file artifacts/mainnet/policy.wasm \
  with-init-call new file-args <INIT.json> \
  prepaid-gas '300 Tgas' attached-deposit '0 NEAR' \
  network-config testnet \
  sign-with-access-key-file <path-to-temp-key.json> send

# 6) Verify
near contract call-function as-read-only <CHILD>.testnet get_paused json-args {} network-config testnet now
near contract call-function as-read-only <CHILD>.testnet get_mpc_signer json-args {} network-config testnet now
near account view-account-summary <CHILD>.testnet network-config testnet now

# 7) Remove temp key (Ledger would sign this step)
near account delete-keys <CHILD>.testnet public-keys <TEMP_PK> \
  network-config testnet sign-with-legacy-keychain send
# Ledger: ... sign-with-ledger send

# 8) Key inventory — only owner/Ledger FA remains
near account list-keys <CHILD>.testnet network-config testnet now

# 9) Owner-only method (requires sign-as)
near contract call-function as-transaction <CHILD>.testnet pause \
  json-args {} prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as <OWNER>.testnet network-config testnet sign-with-legacy-keychain send
```

### Example `INIT.json`

```json
{
  "owner": "<OWNER>.testnet",
  "agent": "<AGENT>.testnet",
  "mpc_signer": "v1.signer-prod.testnet",
  "portfolio_id": "testnet-ledger-rehearsal",
  "verifying_contract": "verifier.tidepool-sandbox.testnet",
  "limits": {
    "max_trade_value": "1000000",
    "daily_turnover_limit": "5000000",
    "max_pending_exposure": "2000000",
    "max_slippage_bps": 100,
    "allowed_assets": ["nep141:wnear.tidepool-sandbox.testnet"],
    "allowed_destinations": ["<OWNER>.testnet"],
    "valid_until": "2000000000000000000",
    "token_scope": "allowlist",
    "allowed_chains": ["near", "eip155:11155111"],
    "allowed_venues": ["near_intents_1click"],
    "max_gas_budget": "100000000000000"
  }
}
```

## Tested rehearsal receipts (2026-11-11)

| Step | Account / artifact | Tx / result |
|------|--------------------|-------------|
| Create child | `policy-rehearse.nio-i-a4e7-a-owner.testnet` | `DpFGfjVHNNt67ycyYh8iuZBHCee1eWcfXnZAzACxKfSm` |
| Add temp FA | `ed25519:5ZCjHuo…51G6` | `3RdMg4zxwPQ8TwJdQCwavdgFzfwgP26n3ad82B4WxTWe` |
| Deploy+init | code `52MidcEUUwVaiNcTtuQbKd1xwVQR8HGer4quihZj8FZZ` | `5vQthfEkhepjRk9mbi1SMxHMLreSGcq4wQcDQvbgppiD` |
| `get_paused` | `true` | read-only |
| Delete temp key | removed | `2nBspRf6RJBguJGG1jgXgWH4ksSpMJmYxFWMmjvNmMD6` |
| Keys after | only `ed25519:2TWST8ofn1XHDPGqTSnpTVcTexUZkx8yTHaKw2sX6ReN` FA | list-keys |
| Owner `pause` | `sign-as nio-i-a4e7-a-owner.testnet` | `DNdZTiQT1xpBCUVujXrPVMd3gDcFxjoZSGAu4py3AutD` |

## Pass criteria

- [x] Local SHA-256 matches approved artifact  
- [x] `get_paused == true` after `new`  
- [x] `get_mpc_signer` correct  
- [x] Temp key **absent** after deletion  
- [x] Owner can call `pause` via `sign-as`  
- [ ] **Ledger device** signs create / delete-key / owner call (pending hardware)  
- [x] No trading inventory required on rehearsal account  

## Mainnet equivalents

Same steps with `network-config mainnet`, `mpc_signer=v1.signer`, verifier `intents.near`, artifact hash above, max **9 Ⓝ** storage float. Still require separate approval JSON (`approved:true`). **Do not unpause** until trading-readiness approval. **Do not broadcast mainnet in this sprint.**
