# Ledger + temporary deploy-key ceremony (testnet rehearsal → mainnet)

**Status:** Designed — testnet rehearsal commands below. **Mainnet broadcast: NOT executed.**  
**Funded trading during temp-key window:** **FORBIDDEN.**

## Why

Ledger NEAR app cannot sign ~625 KB `DeployContract` (device buffer).  
Temporary FullAccess on the **policy account only** deploys WASM; Ledger then deletes that key.

## Final artifact (inert)

| Field | Value |
|-------|-------|
| Path | `artifacts/mainnet/policy.wasm` |
| Bytes | **625701** |
| SHA-256 | **`3bc7c1120a1f593a4c96ff58171ce9521f780ceec0427d97f90f0cac9ecc4f90`** |
| Init | `paused=true` |

## Testnet rehearsal (near-cli-rs)

Prereqs: Ledger + NEAR app; `near` CLI; network-config **testnet**.

```bash
# 1) Ledger-owned parent (if missing)
near account create-account fund-myself <owner>.testnet use-ledger network-config testnet sign-with-ledger send

# 2) Create policy subaccount with Ledger FA on child
near account create-account fund-myself policy.<owner>.testnet \
  use-ledger \
  network-config testnet \
  sign-with-ledger send

# 3) Add temporary FullAccess on POLICY account only (autogen keychain; never commit)
near account add-key policy.<owner>.testnet \
  grant-full-access \
  autogenerate-new-keypair save-to-keychain \
  network-config testnet \
  sign-with-ledger send

# 4) Deploy + init paused (signed by temp key — NOT Ledger)
near contract deploy policy.<owner>.testnet \
  use-file artifacts/mainnet/policy.wasm \
  with-init-call new \
  json-args '{"owner":"<owner>.testnet","agent":"agent.<owner>.testnet","mpc_signer":"v1.signer-prod.testnet","portfolio_id":"testnet-rehearsal","verifying_contract":"verifier.tidepool-sandbox.testnet","limits":{...allowlist + max_gas_budget>0...}}' \
  prepaid-gas '300 Tgas' attached-deposit '0 NEAR' \
  network-config testnet \
  sign-with-keychain send

# 5) Verify views: get_paused=true, get_mpc_signer, code hash
near contract call-function as-read-only policy.<owner>.testnet get_paused json-args {} network-config testnet now
near contract call-function as-read-only policy.<owner>.testnet get_mpc_signer json-args {} network-config testnet now

# 6) Ledger deletes temp key
near account delete-key policy.<owner>.testnet <TEMP_PUBLIC_KEY> \
  network-config testnet sign-with-ledger send

# 7) RPC: only Ledger FA remains
near account list-keys policy.<owner>.testnet network-config testnet now

# 8) Ledger signs pause (idempotent) / set_policy smoke
near contract call-function as-transaction policy.<owner>.testnet pause \
  json-args {} prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as <owner>.testnet network-config testnet sign-with-ledger send
```

## Pass criteria

- [ ] Code hash matches approved SHA-256  
- [ ] `get_paused == true` after `new`  
- [ ] `get_mpc_signer` correct for network  
- [ ] Temp key **absent** from `view_access_key_list`  
- [ ] Ledger can call `pause` / `set_policy`  
- [ ] No trading inventory on policy account during window  

## This workstation

`near` / `near-cli-rs` **not installed** → ceremony **BLOCKED** until CLI + Ledger available for rehearsal receipts.

## Mainnet equivalents

Same steps with `network-config mainnet`, `mpc_signer=v1.signer`, verifier `intents.near`, artifact hash above, max **9 Ⓝ**. Still require separate approval JSON (`approved:true`). **Do not unpause** until trading-readiness approval.
