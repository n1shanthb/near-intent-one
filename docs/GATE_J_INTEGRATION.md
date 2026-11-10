# Gate J ↔ Product UI contract

Date: 2026-11-10  
Product: `apps/web` Agent page  
API: `packages/services/gate-j-routes.mjs` · shapes `packages/agent-api/gate-j.ts`  
Fitter: deterministic (`packages/gate-j/fitter.mjs` · TS mirror `apps/web/src/lib/mandateFitter.ts`)

## Hero claim

**NIO finds the best viable version of an AI strategy within the owner's rules — and NEAR enforces those rules.**

Pipeline: Market Researcher → AI Strategist → Deterministic Mandate Fitter → Independent Risk Critic → Enforcement. LLM + Fitter never authorize signing.

## Modes (must stay separate)

| Mode | What it is | Label |
|------|------------|-------|
| **LIVE AI / DRY RUN** | Hosted `POST /v1/gate-j/decide` `{ use_llm: true, dry_run: true }` | Real model ids; `may_sign=false` |
| **FIXTURE SCENARIOS** | `scenario: ALLOWED\|ADAPTED\|REJECTED` or local Fitter | `demo_fixture` · not live LLM |
| **RECORDED ON-CHAIN** | Gate I/H historical evidence | Never implied as LLM pipeline |

## Routes

| Route | Purpose |
|-------|---------|
| `GET /v1/gate-j/health` | Unlocks Live AI button |
| `POST /v1/gate-j/decide` | Live or fixture dry-run trace |
| `GET /v1/gate-j/decisions` | History |
| `GET /v1/gate-j/scenarios` | Scenario ids |
| `GET/POST /v1/gate-j/market` | Market snapshot |

Browser never receives OpenRouter keys. Optional `VITE_GATE_I_API_KEY` is a product API key for authenticated mutations only.

## Mandate source

| Source | When |
|--------|------|
| `authoritative_onchain` | `VITE_GATE_J_ONCHAIN_MANDATE=true` + portfolio |
| `demo_fixture` | Live dry-run / fixture until hydration |
| `recorded_evidence` | Historical panels |

## BLOCKED UX

Strategist TRADE + Critic REJECT + Enforcement BLOCKED is a **correct safety result**, shown as enforced success with the story:

> Claude proposed a trade. NIO checked the owner's mandate. GPT independently rejected the proposal. NIO blocked signing.

## Secrets

No OpenRouter / seeds / FullAccess keys in Vite env.
