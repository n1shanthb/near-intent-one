# Checkpoint J8B-0 - One-shot mainnet canary executor wiring

**NO Ledger / NO unpause / NO propose / NO request_signature / NO broadcast**

## Readiness

**READY_FOR_J8B_OWNER_APPROVED_LIVE_EXECUTION_CHECKPOINT**

## Default gates (must stay locked)

```json
{
  "funded_trading": false,
  "mainnet_broadcast_enabled": false,
  "autonomous_execution_enabled": false,
  "observe_only": true,
  "unlock_attempted_ignored": false,
  "auth_gates_raw": {
    "network_is_mainnet": false,
    "mainnet_mode": false,
    "allow_sign": false,
    "allow_broadcast": false,
    "canary_approved": false,
    "public_demo_safe": true
  },
  "note": "J3 default: broadcast gates hard-false; canary one-shot is separate scoped unlock"
}
```

## Hard-blocker fixes

- **set_paused does not exist**: Ledger runbook uses unpause()/pause() (`packages/mainnet/canaryLedgerRunbook.mjs`)
- **safetyGates hard-false**: Default remains hard-false; scoped one-shot canary unlock only via validated approval (`packages/mainnet/safetyGates.mjs`)
- **assertMainnetFundedAllowed always rejects**: Allows only when canaryUnlock.mode===one_shot_canary with journal+deposit bind (`packages/execution/chainProfiles.mjs`)
- **agentRuntime requires paused=true**: Preserved for observe agent; canary is separate CLI, not agent tick (`packages/mainnet/agentRuntime.mjs`)
- **mainnet-api-server observation-only**: Preserved — canary execution is local CLI, not HTTP tick (`packages/services/mainnet-api-server.mjs`)
- **1Click status needs depositAddress**: canarySettlement.monitorOneClickByDeposit uses GET /v0/status?depositAddress= (`packages/mainnet/canarySettlement.mjs`)

## Ledger preview (DO NOT RUN)

### unpause()
```powershell
# DO NOT RUN until J8B live execution approved
# Method: unpause() — opens agent propose/sign window
$near = "C:\Users\Nishanth\bin\near-cli-rs\near-cli-rs-x86_64-pc-windows-msvc\near.exe"
$HD = "m/44'/397'/0'/0'/1'"
$ARGS = "C:\Users\Nishanth\.nio-secure\mainnet-canary\unpause.args.json"

& $near contract call-function as-transaction policy.nishanthb.near unpause file-args $ARGS `
  prepaid-gas '30.0 Tgas' `
  attached-deposit '0 NEAR' `
  sign-as nishanthb.near `
  network-config mainnet `
  sign-with-ledger --seed-phrase-hd-path $HD `
  usb

```

### pause()
```powershell
# EMERGENCY / post-canary close window
# Method: pause() — does NOT cancel already-signed or broadcast EVM txs
$near = "C:\Users\Nishanth\bin\near-cli-rs\near-cli-rs-x86_64-pc-windows-msvc\near.exe"
$HD = "m/44'/397'/0'/0'/1'"
$ARGS = "C:\Users\Nishanth\.nio-secure\mainnet-canary\pause.args.json"

& $near contract call-function as-transaction policy.nishanthb.near pause file-args $ARGS `
  prepaid-gas '30.0 Tgas' `
  attached-deposit '0 NEAR' `
  sign-as nishanthb.near `
  network-config mainnet `
  sign-with-ledger --seed-phrase-hd-path $HD `
  usb

```

## Residual risk

- pause() or remove_trusted_quote_signer does NOT invalidate an EVM tx already MPC-signed or broadcast
- If MPC signature exists without confirmed broadcast: retain durable journal; operator reconciliation only; never auto-resign
- Do not generate a replacement transaction at the same nonce without owner cancel path

## Next

Next checkpoint: owner-approved first live execution with operator confirmation at each mutation (unpause → propose → sign → broadcast → settle → pause)
