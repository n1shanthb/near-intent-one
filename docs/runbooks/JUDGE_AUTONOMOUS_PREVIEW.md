# Judge preview runbook — Autonomous Mandate V1

## Two entry points (product)

1. **Inspect Nishanth’s live mainnet agent** — read-only: paused, epoch, autonomous=false, historic J8B/M1/M2 evidence.  
2. **Set your own mandate** — Mandate V1 composer + **mainnet review-only** preview (no auto-sign).

## Local verification

```powershell
cd E:\near-intent-one
node --test packages/mandate/v1/v1.test.mjs
node --test packages/autonomous/autonomous.test.mjs
cd contracts/policy; cargo test enforce_autonomous
```

## Shadow cycle

```powershell
node --input-type=module -e "import { simulateCycle } from './packages/autonomous/simulateCycle.mjs'; console.log(JSON.stringify(await simulateCycle({}), null, 2))"
```

Expect: mandate draft → research → optional mocked BUY_DATA → HOLD/WAIT or guarded TRADE proposal → journal replay. **No** mainnet txs.

## Modes to display

| Label | Meaning |
|-------|---------|
| LIVE ONCHAIN | Deployed policy views only |
| TESTNET | Safe signing env (when configured) |
| DRY RUN / SHADOW | AI + mocks; no financial sign |
| PAPER | Non-funded simulation |
| PLANNED / NOT ENFORCED | Schema field without contract path |

Never present a UI preview as a signed active mandate.
