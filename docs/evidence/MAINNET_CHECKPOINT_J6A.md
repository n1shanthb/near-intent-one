# Checkpoint J6A — Prepare trusted mainnet attestor

**NO Ledger sign / NO on-chain mutation / NO deposit / NO funding**

## Attestor (public only)

| Item | Value |
|------|-------|
| Public key | `ed25519:6oqnd5mBShyMGGHCgrJEEEPtgAEsXzJEPfARf7Fc2CG9` |
| Secret path | `C:\Users\Nishanth\.nio-secure\mainnet-attestor\attestor.ed25519.json` (contents never logged) |
| is_trusted_quote_signer (before) | **false** |

## Fresh quote → attestation

**PASS** · local sig verify=true · Rust QUOTE_AUTH_V2 format=true

Negatives: expired BLOCKED=true · mutated deposit BLOCKED=true

## Ledger registration (DO NOT RUN until J6B)

```powershell
# DO NOT RUN until J6B approved
$near = "C:\Users\Nishanth\bin\near-cli-rs\near-cli-rs-x86_64-pc-windows-msvc\near.exe"
$HD = "m/44'/397'/0'/0'/1'"
$ARGS = "C:\Users\Nishanth\.nio-secure\mainnet-attestor\set_trusted_quote_signer.args.json"

& $near contract call-function as-transaction policy.nishanthb.near set_trusted_quote_signer file-args $ARGS `
  prepaid-gas '100.0 Tgas' `
  attached-deposit '0 NEAR' `
  sign-as nishanthb.near `
  network-config mainnet `
  sign-with-ledger --seed-phrase-hd-path $HD `
  usb

```

## Emergency removal

```powershell
# EMERGENCY remove — only if needed
$near = "C:\Users\Nishanth\bin\near-cli-rs\near-cli-rs-x86_64-pc-windows-msvc\near.exe"
$HD = "m/44'/397'/0'/0'/1'"
$ARGS = "C:\Users\Nishanth\.nio-secure\mainnet-attestor\remove_trusted_quote_signer.args.json"

& $near contract call-function as-transaction policy.nishanthb.near remove_trusted_quote_signer file-args $ARGS `
  prepaid-gas '100.0 Tgas' `
  attached-deposit '0 NEAR' `
  sign-as nishanthb.near `
  network-config mainnet `
  sign-with-ledger --seed-phrase-hd-path $HD `
  usb

```

## Readiness for J6B

**READY_FOR_J6B_LEDGER_REGISTRATION_APPROVAL**
