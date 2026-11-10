# Gate I ↔ Product UI contract

Date: 2026-11-10 (withdraw proven — Chat 2 notify)  
Product consumes: `packages/agent-api/gate-i.ts` via `apps/web/src/adapters/gatei.ts`  
Backend: `packages/services/api-server.mjs` · Deploy: `docs/GATE_I_DEPLOY.md` · OCI: `docs/GATE_I_OCI.md`  
**Demo `nio-c-*` Ledger custody is never used for personal portfolios.**

## Chat 2 notify (2026-11-10)

Sepolia withdrawal delivery is **proven**. Set:

| Var | Value |
|-----|-------|
| `VITE_GATE_I_WITHDRAW_PROVEN` | `true` |
| `VITE_GATE_I_API_BASE` | `http://129.225.72.169:8787/v1` (OCI) or local `http://127.0.0.1:8787/v1` |

Proof: `GATE_I.md` B2 PASS — Sepolia tx [`0x2d11b9a6…3408d`](https://sepolia.etherscan.io/tx/0x2d11b9a650b92f422c39edbe89002f4722598adf44367e0f6a79bcd89a33408d) status `0x1`, Transfer **0.1 USDC** → `0x9950ce47…ac39`.

## Env (web)

| Var | Purpose |
|-----|---------|
| `VITE_GATE_I_API_BASE` | Hosted API base including `/v1`, e.g. `http://129.225.72.169:8787/v1` or `http://127.0.0.1:8787/v1` |
| `VITE_GATE_I_WITHDRAW_PROVEN` | **`true` authorized** after Sepolia withdraw receipt PASS in `GATE_I.md` |
| `VITE_NETWORK` | must remain `testnet` |

Secrets stay server-side. Frontend never receives attestor seeds, software FullAccess keys, or migration private keys.

## Routes (`GATE_I_ROUTES`)

| Route | Chat 2 usability |
|-------|------------------|
| `GET /v1/health` | **Usable** — gates personal UI |
| `POST /v1/portfolios` | **Usable** for provisioned owners A/B; **blocked** for arbitrary new wallets (guided reason) |
| `GET /v1/portfolios/:id` | **Usable** (read) |
| `GET /v1/portfolios/:id/balances` | **Usable** (live Sepolia + Intents reads) |
| `POST /v1/portfolios/:id/deposits` | **Usable** — returns deposit address; funding is off-band |
| `POST .../withdrawals/quote` | **Usable** — allowlist check; always `requires_owner_signature: true` |
| `POST .../withdrawals` | **Blocked** in production API (owner must wallet-sign); harness only if `GATE_I_ALLOW_SERVER_OWNER_SIGN=1` |
| `GET/POST .../agent` | **Usable** start/stop/state once portfolio funded + unpaused |
| Policy / revoke / pause | **Read-only via API** — owner signs on-chain with wallet/Ledger (not server keys) |

## Frontend flags

| Condition | UI behavior |
|-----------|-------------|
| Health fail / unset base | Gate I unavailable; disable create/deposit/withdraw/start |
| Health ok, withdraw not proven | Show deposit + balances; withdraw CTA disabled or “pending proof” |
| `VITE_GATE_I_WITHDRAW_PROVEN=true` | Enable withdraw UX that requests **owner** signature |

## Demo vs personal

| Mode | Custody |
|------|---------|
| Explore / Judge demo | Recorded F4/H3 evidence only — `nio-c-policy-857107` |
| Personal portfolio | Gate I ids only (`i-a-a4e7`, `i-b-a4e7`, …) |

## Backend status

- [x] Hosted API process + `/health` + CORS + API key auth model + persistence dir
- [x] Per-user policy deploy + MPC path (`scripts/gate-i-provision.mjs`)
- [x] Dual-user A/B isolation
- [x] Owner withdraw MPC while paused (NEAR)
- [x] Sepolia ETH+USDC fund of new MPC A (`0xe1790149…` + 50 USDC)
- [x] Sepolia withdraw **broadcast receipt** + recipient Δ (`0x2d11b9a6…`)
- [x] New-user trade + Tidepool SUCCESS + reconcile (`0x26b9c08a…`)
- [x] OCI Always Free API `http://129.225.72.169:8787/v1` (`docs/GATE_I_OCI.md`)
- [ ] Optional TLS/DNS in front of OCI IP

## Exact Chat 2 contract types

Keep `apps/web/src/types/gateI.ts` aligned with `packages/agent-api/gate-i.ts` (`PortfolioRecord`, `BalanceSlice`, `WithdrawReceipt`, `AgentRuntimeState`, …). Do not invent SUCCESS balances or withdraw receipts client-side.
