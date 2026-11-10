# Gate I UI integration report

Date: 2026-11-09  
Frontend: `apps/web`  
Backend: OCI `http://129.225.72.169:8787/v1` (also local `127.0.0.1:8787`)  
Closure: `GATE_I.md` overall **PASS** (2026-11-10)

## Connected endpoints (verified live)

| Method | Path | Result |
|--------|------|--------|
| GET | `/v1/health` | `ok: true`, network `testnet`, agent/attestor/reconciler up |
| POST | `/v1/portfolios` | User A/B provisioned owners → `ready`; unknown → `blocked`; demo `nio-c-*` → rejected |
| GET | `/v1/portfolios/:id` | Returns distinct A/B records |
| GET | `/v1/portfolios/:id/balances` | Live Sepolia/Intents reads (currently `0`) |
| POST | `/v1/portfolios/:id/deposits` | Deposit address = MPC / intents_signer_id |
| POST | `/v1/portfolios/:id/withdrawals/quote` | Allowlist check; invalid dest blocked |
| POST | `/v1/portfolios/:id/withdrawals` | `blocked` without owner wallet sign / delivery proof |
| GET/POST | `/v1/portfolios/:id/agent` start/stop | Works for provisioned portfolios |

UI env: `apps/web/.env.local` / `.env.example` / `.env.production.example`  
`VITE_GATE_I_API_BASE=http://129.225.72.169:8787/v1`  
`VITE_GATE_I_WITHDRAW_PROVEN=true` (Chat 1 authorized after Sepolia `0x2d11b9a6…`)

## Real working actions

- Health probe + sidebar Gate I pill + 30s refresh
- Create/load portfolio for provisioned owners A/B
- Live balances (zeros, not placeholders)
- Deposit address request
- Withdraw quote / destination validation
- Agent start/stop against hosted service
- Per-owner localStorage isolation + clear on disconnect
- Journey strip: Connect → Portfolio → Deposit → Policy → Agent → Activity → Withdraw
- Honest withdraw lifecycle UI (Signed ≠ Received)

## Closure PASS evidence (Chat 1)

| Item | Result |
|------|--------|
| Deposit | PASS — faucet `0xe1790149…` (0.05 ETH) + 50 USDC on A |
| Withdraw Received | PASS — Sepolia `0x2d11b9a6…` → 0.1 USDC @ `0x9950ce47…` |
| Trade | PASS — Sepolia `0x26b9c08a…` Tidepool SUCCESS |

## Still limited (honest)

| Action | Why |
|--------|-----|
| Self-serve portfolio for arbitrary wallets | Interactive factory not on this host |
| Pause/revoke/`set_policy` via HTTP | Owner signs on-chain; convenience routes pending |
| TLS/DNS on OCI | Optional — IP API is live on `:8787` |

Early NEAR `withdraw_signed` `8mvQe6Sk…` remains labeled **Signed**; closure Sepolia is **Received**.

## Isolation (UI)

- Distinct cache keys per owner (`nio.portfolio.v1:<account>`)
- Legacy shared key removed
- Wallet switch reloads that owner’s portfolio only
- Disconnect clears session
- Portfolio bind refused if `owner_account` ≠ connected wallet
- Balances cleared on portfolio/owner change
- Demo Ledger `nio-c-*` path kept separate from Gate I owners

## Tests

```text
npm test  → pass (incl. gatei, withdrawLifecycle, sessionIsolation)
npm run build → pass
```

## Remaining deployment tasks (exact)

1. Deploy static `apps/web/dist` with `.env.production.example` values (OCI API + withdraw proven).
2. Prefer TLS/DNS in front of `129.225.72.169:8787`; tighten CORS for the site origin.
3. Keep secrets server-side — never ship `GATE_I_ALLOW_SERVER_OWNER_SIGN` or ledger-migrate.
4. Smoke against OCI: A/B wallet switch, reconnect, owner-signed withdraw quote→confirm.
5. Optional: pause/revoke/policy HTTP convenience routes.

## Do not claim

- Completed withdrawals / Received funds
- Public beta live until steps 1–2 + 7 done
- Cross-user admin or shared demo custody for personal funds
