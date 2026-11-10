# GATE J — Mandate-Aware AI Trading Intelligence

Date: 2026-11-10  
Deadline target: 2026-11-14  
Mode: **dry-run by default** (no additional funded Sepolia trades without explicit authorization)  
Depends on: Gate I PASS (`GATE_I.md`) — deposit / withdraw / trade preserved; `nio-c-*` demo untouched.  
LLM provider: **OpenRouter only** (not direct OpenAI / Anthropic APIs).

## Differentiator

> **The AI proposes. The Fitter adapts. The Critic challenges. NEAR enforces.**

| Role | Implementation | Model | Signs? | Changes policy? |
|------|----------------|-------|--------|-----------------|
| Market Researcher | LLM (`packages/gate-j/researcher.mjs`) | `google/gemini-2.5-flash` | No | No |
| AI Strategist | LLM (`packages/gate-j/strategist.mjs`) | `anthropic/claude-sonnet-4.6` | No | No |
| Mandate Fitter | **Deterministic** (`packages/gate-j/fitter.mjs`) | **NO LLM** | No | No |
| Independent Risk Critic | LLM (`packages/gate-j/critic.mjs`) | `openai/gpt-5.2` | No | No |
| Forecast Engine | Statistical / historical | **NO LLM** | No | No |
| Policy Guard / Executor / Reconciler | Deterministic Gate I path | **NO LLM** | Contract-gated only | Owner-only |
| AI Copilot (optional) | Same adapter | `google/gemini-2.5-flash` | No | No |

**LLM output and Fitter output are never signing authorization.**

Workflow:

```
Verified market data (CoinGecko + named sources)
  → Researcher LLM
  → Strategist LLM
  → Deterministic Mandate Fitter
  → Independent Risk Critic LLM
  → Deterministic enforcement
  → NO_TRADE or authorized execution (funded path hard-disabled by default)
```

## Outcomes (exactly one from Fitter)

| Outcome | Meaning |
|---------|---------|
| **ALLOWED** | Proposal already fits the authoritative mandate |
| **ADAPTED** | Size/slippage/quote adjusted within bounds; thesis preserved |
| **REJECTED** | Feasible set empty / min-viable unmet / hard constraint |

Critic `REJECT` / `ABSTAIN` → fail closed for automation. Critic `APPROVE` is **advisory only**.

## Package layout

```
packages/gate-j/
  researcher.mjs      # OpenRouter Researcher
  strategist.mjs      # OpenRouter Strategist + fixture
  critic.mjs          # OpenRouter Critic + fixture
  fitter.mjs          # deterministic optimizer (no LLM)
  enforce.mjs         # final independent checks
  pipeline.mjs        # market → research → strategy → fit → critic → enforce
  market.mjs          # CoinGecko + Tidepool sourced snapshots
  llm.mjs             # OpenRouter-only adapter (per-role models)
  fixtures.mjs
  fitter.test.mjs
packages/services/.env.example   # template — never put real keys here
packages/services/.env           # gitignored secrets
packages/services/gate-j-routes.mjs
packages/agent-api/gate-j.ts
scripts/gate-j-demo.mjs
evidence/live/gate-j-*.json
```

## Environment (OpenRouter)

Copy `packages/services/.env.example` → `packages/services/.env` (gitignored):

```bash
GATE_J_LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...          # server-side only
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
GATE_J_RESEARCH_MODEL=google/gemini-2.5-flash
GATE_J_STRATEGIST_MODEL=anthropic/claude-sonnet-4.6
GATE_J_CRITIC_MODEL=openai/gpt-5.2
GATE_J_COPILOT_MODEL=google/gemini-2.5-flash
GATE_J_LLM_TIMEOUT_MS=60000
GATE_J_LLM_MAX_RETRIES=2
GATE_J_LLM_MAX_TOKENS=2048
GATE_J_LLM_MAX_SPEND_USD=1.00
```

- **Do not** set `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` for Gate J — there is no accidental fallback.
- **Do not** put keys in Vite / frontend env.
- Health/evidence responses expose `configured: true|false` and model ids — **never** the API key.
- Model selection is env-configurable without code changes.

Verified in OpenRouter catalog (2026-11-10): all four model ids above are listed.

## API (authenticated when `GATE_I_API_KEY` set)

| Route | Purpose |
|-------|---------|
| `GET /v1/gate-j/health` | Gate J + LLM config (no secrets) |
| `GET/POST /v1/gate-j/market` | Market snapshot |
| `GET /v1/gate-j/scenarios` | ALLOWED / ADAPTED / REJECTED ids |
| `POST /v1/gate-j/strategist` | Strategist stage (pipeline) |
| `POST /v1/gate-j/fit` | Mandate fit |
| `POST /v1/gate-j/critic` | Risk review |
| `POST /v1/gate-j/decide` | Full dry-run decision trace |
| `GET /v1/gate-j/decisions` | History |

```bash
curl -s -X POST http://127.0.0.1:8787/v1/gate-j/decide \
  -H "content-type: application/json" \
  -H "x-api-key: $GATE_I_API_KEY" \
  -d '{"scenario":"ADAPTED","dry_run":true}'
```

## Demonstration scenarios (fixtures — no LLM)

Thesis id: `usdc-to-wnear-mandate-fit-v1`

| Id | Propose | Permit | Min viable | Expected fit |
|----|---------|--------|------------|--------------|
| A ALLOWED | $10 | $20 | $5 | ALLOWED @ $10 |
| B ADAPTED | $100 | $20 | $10 | ADAPTED @ $20 |
| C REJECTED | $100 | $20 | $50 | REJECTED (min viable) |

```bash
node --test packages/gate-j/fitter.test.mjs
npm run gate-j:demo
npm run gate-j:demo:llm   # genuine OpenRouter trace when OPENROUTER_API_KEY set
```

## Evidence

| File | Contents |
|------|----------|
| `evidence/live/gate-j-allowed.json` | Fixture ALLOWED |
| `evidence/live/gate-j-adapted.json` | Fixture ADAPTED |
| `evidence/live/gate-j-rejected.json` | Fixture REJECTED |
| `evidence/live/gate-j-scenarios.json` | Summary matrix |
| `evidence/live/gate-j-live-llm.json` | **OpenRouter** Researcher + Strategist + Critic — labeled; dry-run; sanitized |

Live evidence must include provider `openrouter`, requested/returned model ids, request ids when available, market sources/timestamps, fitter result, critic verdict, token usage / latency / estimated cost, `DRY_RUN=true`, and `no_signing`.

Fixture fallbacks are **never** labeled as real AI results. LLM failure → fail closed (`NO_TRADE`).

## Live OpenRouter evidence

### Local
`evidence/live/gate-j-live-llm.json` — `verified_real_ai: true`

### Hosted (authoritative mandate + verified balances)
`evidence/live/gate-j-hosted-live-llm.json`

| Field | Value |
|-------|-------|
| Trusted HTTPS | `https://consider-deserve-findarticles-carol.trycloudflare.com/v1` (Cloudflare quick tunnel; ephemeral) |
| OCI origin | `https://129.225.72.169:8787/v1` (self-signed) |
| Mandate | `on_chain:get_gate_j_mandate` |
| Balance | **48.9 USDC** Sepolia ERC-20 — Strategist receives live verified balances |
| Strategist | TRADE ~$24.45 (`24450000` raw) |
| Fitter | `REJECTED` / `ECONOMIC_NOT_VIABLE` (edge &lt; costs; honest) |
| Critic | `REJECT` |
| Enforcement | `BLOCKED` · codes `FITTER_REJECTED` + `ECONOMIC_NOT_VIABLE` + `CRITIC_VETO` · `may_sign=false` |
| Reconciler | **booted** |
| Tests | **30/30** |

Fixture ALLOWED/ADAPTED demos remain. Live run was not forced to APPROVE.

Balance/pending notes: `evidence/live/gate-j-balance-pending-reconcile.json`. Prior 100 USDC “balance” was a hydrate bug (per-trade limit fallback) — fixed fail-closed. Withdraw `i-wd-…` reconciled via Sepolia `0x2d11b9a6…`; dust `i2-wd` left pending without receipt.

## Assessment: **Gate J BLOCKED (not product PASS)**

Backend corrections for enforcement, balances, pending reconcile, and hosted OpenRouter are done. Product PASS still needs stable trusted hostname + live frontend Chat 2 using authoritative decide.

## Remaining blockers

1. **Stable trusted hostname** (named Cloudflare tunnel / DNS+cert) — quick tunnel URL is ephemeral
2. **Chat 2 UI wiring** to hosted decide with `portfolio_id` only (no embedded privileged API key)
3. **Funded AI execution** — intentionally hard-disabled
4. Dust pending withdraw (`i2-wd`, 1 raw) awaits receipt or explicit terminalization
5. Micro VM RAM (~500 MiB)

## Security boundaries (unchanged)

1. Per-user NEAR policy + MPC path  
2. Demo `nio-c-*` never used  
3. Independent reconciler  
4. Fail-closed critic / stale data / malformed LLM / spend cap  
5. Testnet only  
6. Dry-run default — no surprise spends  
7. OpenRouter key never in browser or logs
