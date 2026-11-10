# Product UI — final integration notes

## Status

- **User product screens shipped**: Welcome, Portfolio, Deposit/Withdraw, Policies, Agent, Activity, Security
- Gate I overall **PASS** (`GATE_I.md`) — deposit, Sepolia withdraw Received, trade closed
- Hosted API: `http://129.225.72.169:8787/v1` · `VITE_GATE_I_WITHDRAW_PROVEN=true`
- Demo `nio-c-*` Ledger custody untouched / separate from Gate I owners
- Hardware ownership **VERIFIED** (H1) on demo contract — separate from device **CONNECTED**
- H3 recorded evidence kept labeled vs live Gate I runtime
- `/api/ledger-migrate` localhost-only; absent from production static deploy

## Run / deploy

See `apps/web/README.md` and `docs/GATE_I_INTEGRATION.md`.

## Remaining (non-blockers)

1. TLS/DNS in front of OCI IP
2. Self-serve wallet factory for non-provisioned owners
3. Ordinary-wallet policy/pause/revoke HTTP convenience (on-chain owner path exists)
4. Public static UI deploy with production env

## Still unsupported (honest)

1. LLM Policy Copilot (typed compiler only)
2. Mainnet trading
3. On-chain `evidence_hash` verification
4. Historical Predict market feeds (illustrative only)
5. Fabricated personal balances / fake withdraw SUCCESS
