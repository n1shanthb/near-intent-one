# near-intent-one — testnet product UI

**Your hardware wallet sets the rules. Your AI trades across chains. NEAR enforces the boundaries.**

Tracks: `defi` · `security` · `agents`  
Network: **testnet only**  
Gate I: **PASS** (see `GATE_I.md`) — deposit / Sepolia withdraw Received / trade closed.

## Product journey

Connect → Portfolio → Deposit → Policy → Agent → Activity → Withdraw

Personal funds never use shared demo custody (`nio-c-policy-857107.testnet`).

## Gate I API (Chat 1)

| Env | Value |
|-----|-------|
| `VITE_GATE_I_API_BASE` | `http://129.225.72.169:8787/v1` (OCI) or `http://127.0.0.1:8787/v1` |
| `VITE_GATE_I_WITHDRAW_PROVEN` | `true` (authorized 2026-11-10 after Sepolia `0x2d11b9a6…`) |

```powershell
cd E:\near-intent-one\apps\web
# .env.local / .env.example already point at OCI + withdraw proven
npm install
npm run dev
```

- Welcome: http://127.0.0.1:5173/welcome  
- Contract: `docs/GATE_I_INTEGRATION.md` · OCI: `docs/GATE_I_OCI.md`

## Build / test

```powershell
npm test
npm run build
npm run preview
```

## Public beta deploy

1. Copy `apps/web/.env.production.example` into host env (OCI API + `VITE_GATE_I_WITHDRAW_PROVEN=true`).
2. Prefer TLS/DNS in front of the OCI IP when available.
3. `npm run build` → deploy `dist/` (Vercel SPA via `vercel.json`).
4. Never enable `/api/ledger-migrate` or `GATE_I_ALLOW_SERVER_OWNER_SIGN` in production.

## Entry paths

| Path | Behavior |
|------|----------|
| Connect Ledger | Hardware authorization · separate from Gate I software owners |
| Connect NEAR wallet | Provisioned Gate I owners A/B · personal portfolio |
| Explore / Judge demo | Recorded F–H evidence |
| Predict | Illustrative simulation only |

## Gate J (Agent page)

- **LIVE AI / DRY RUN** — `portfolio_id` + `claimed_owner` → backend on-chain mandate (no client policy). OpenRouter stays server-side
- **Auth** — use `VITE_GATE_I_API_BASE=/api/v1` (Vite BFF injects `GATE_I_API_KEY` from `packages/services/.env`). Never put API keys in `VITE_*`
- **FIXTURE** — ALLOWED / ADAPTED / REJECTED deterministic Fitter demos
- **RECORDED** — hosted OCI OpenRouter trace + Gate I/H settlement; never confuse with fixtures
- See `docs/GATE_J_UI_REPORT.md`

## Still limited

- Arbitrary wallet self-serve portfolio factory  
- Optional TLS/DNS on OCI API  
- Ordinary-wallet set_policy / pause / revoke via HTTP (owner signs on-chain)
- Hosted OCI Gate J routes (Chat 1 redeploy) + public SPA env pointing at HTTPS API  
