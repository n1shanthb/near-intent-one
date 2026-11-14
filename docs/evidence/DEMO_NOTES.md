# NIO Mainnet Autonomy Demo — operator notes

## Status

**Blocked only on physical Ledger USB** (`LedgerHidError(DeviceNotFound)`). All software prep is ready.

| Gate | Status |
|------|--------|
| WASM SHA256 = J14 `8BF2AEAF…` | PASS (local artifact) |
| Destination `policy.nishanthb.near` | PASS |
| Balance / storage | PASS (~7.995 NEAR) |
| DeployContract | **BLOCKED — Ledger USB** |
| migrate / mandate / unpause | waiting on deploy |
| LIVE_LLM keeper cycle | PASS — `NO_TRADE` / `NO_OPPORTUNITY` |
| Autonomous mainnet trade settled | N/A until unpaused + TRADE |

## Sequence (Ledger unlocked, NEAR app open)

```powershell
node scripts/mainnet/j18-deploy-upgrade.mjs --execute-deploy
node scripts/mainnet/j18-deploy-upgrade.mjs --execute-migrate
node scripts/mainnet/activate-mandate.mjs --activate
node scripts/mainnet/activate-mandate.mjs --unpause
$env:NIO_MAINNET_AUTONOMOUS_EXEC='1'
node scripts/mainnet/autonomous-demo-cycle.mjs
```

Or one script: `scripts\mainnet\ship-autonomy-today.ps1`

Confirm each distinct Ledger prompt. Chat approval ≠ device signature.

## Live decision already captured

- `decision_hash`: `f9d7df6976a6520662e56d1500fad72d78a23c064850819139ba9f4cdb47cd5b`
- Action: `NO_TRADE` (valid autonomous refusal)
- Evidence: `docs/evidence/AUTONOMOUS_KEEPER_RUNNING.json`

Prior Mission 1/2 canaries are **supervised**, not autonomous mainnet trades.
