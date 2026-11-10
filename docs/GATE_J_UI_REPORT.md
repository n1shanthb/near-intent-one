# Gate J frontend report — Final public integration

Date: 2026-11-10

## Public SPA URL

| Surface | URL | Notes |
|---------|-----|-------|
| **Judge demo (local)** | `http://127.0.0.1:5173/` → Agent | BFF `/api/v1` → local API; keys server-side |
| Hosted production SPA | **Not deployed** | Blocked on trusted API TLS (self-signed `https://129.225.72.169:8787` is diagnostic-only) |

## Hosted API integration results

Base probed: `https://129.225.72.169:8787/v1` (self-signed; Node `NODE_TLS_REJECT_UNAUTHORIZED=0`)

| Check | Result |
|-------|--------|
| Gate I `GET /health` | **200** ok · `gate_j` present · auth required for mutations |
| Gate J `GET /gate-j/health` | **200** OpenRouter configured · Gemini / Claude Sonnet 4.6 / GPT-5.2 |
| Gate J `GET /gate-j/scenarios` | **200** ALLOWED / ADAPTED / REJECTED |
| Gate J `GET /gate-j/decisions` | **401** without API key (privileged GET) |
| Gate J `GET /gate-j/market` | **401** without API key |
| Authenticated decide/fit | **401** with local `GATE_I_API_KEY` (hosted key differs) |
| On-chain mandate evidence | Confirmed in `evidence/live/gate-j-hosted-live-llm.json` |

### Actual hosted decision (do not mislabel)

```text
Gemini Researcher
→ Claude Strategist: NO_TRADE
→ Deterministic Fitter: REJECTED
→ GPT Critic: ABSTAIN
→ Enforcement: BLOCKED / may_sign=false
mandate_source: on_chain:get_gate_j_mandate
mandate_epoch: 3 · policy_hash: gate-i-closure-v1 · portfolio: i-a-a4e7
```

Safety story in UI: *Claude declined an inadequately supported trade… GPT abstained… Enforcement BLOCKED signing.*

## Local BFF + browser verification

| Check | Result |
|-------|--------|
| Vite BFF `GET /api/v1/gate-j/health` | **200** |
| Fixture B via BFF | **ADAPTED** $100→$20 · `demo_fixture` labeled |
| Recorded hosted OCI trace button | Shows NO_TRADE / ABSTAIN / BLOCKED · on-chain mandate fields |
| Live AI button | Requires connected portfolio owner (`claimed_owner`) |
| No `VITE_GATE_I_API_KEY` | Removed — server `GATE_I_API_KEY` via `vite-plugin-gate-proxy` only |
| Funded execution | Hard-disabled in UI + proxy |

Screenshots captured in-session (Agent LIVE AI panel, hosted NO_TRADE/ABSTAIN journey, fixture scenarios).

## Test / build

```text
apps/web npm test  → 31/31 passed
apps/web npm run build → green
```

## Auth model (Chat 2)

- Privileged keys **never** in `VITE_*`
- Local/demo: same-origin `/api/v1` BFF allowlists dry-run Gate J + health/balances
- Production: needs Chat 1 trusted hostname + owner session or equivalent BFF on Vercel (server env `GATE_I_API_KEY` / `GATE_I_UPSTREAM`)
- Live decide body: `{ portfolio_id, claimed_owner, use_llm:true, dry_run:true }` only — **no client mandate**

## Remaining blockers

1. **Trusted HTTPS hostname** for OCI API (Let's Encrypt / Cloudflare Tunnel) before public SPA deploy
2. **Shared/hosted demo auth** — local API key ≠ OCI key; coordinate owner session or restricted BFF secret with Chat 1
3. **Wallet connect** in browser to exercise live on-chain decide end-to-end from SPA
4. **Vercel SPA + serverless BFF** deploy after (1)
5. Keep **funded AI execution** disabled

`VITE_GATE_J_ONCHAIN_MANDATE=true` is set locally after BFF + hydration path verification; production example stays `false` until trusted TLS + public BFF ship.
