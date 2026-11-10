# NIO public LIVE AI demo — enablement report

**Date:** 2026-11-10  
**Public URL:** https://near-intent-one.vercel.app  
**Status:** **PASS**

## Deployment

| Item | Value |
|------|--------|
| SPA | https://near-intent-one.vercel.app |
| OCI API | `https://nio-api-hack26.duckdns.org/v1` |
| BFF | `apps/web/api/index.ts` · `maxDuration=100` |
| Flags | `NIO_PUBLIC_LIVE_AI=true`, `VITE_PUBLIC_LIVE_AI=true` |

### BFF routes

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/v1/gate-j/demo-status` | Public quota/kill-switch |
| POST | `/api/v1/gate-j/demo-decide` | Live OpenRouter dry-run only |
| POST | `/api/v1/gate-j/decide` | **Fixtures only** (`use_llm` → 403) |
| POST | `/api/v1/gate-k/*` | **Blocked** |

Client identity: signed HttpOnly `nio_demo_cid` cookie → synthetic `x-forwarded-for` (browser XFF ignored). Server injects `GATE_I_API_KEY`; browser auth headers discarded.

## Live-AI browser test

Opened `/agent`, clicked **Run Live AI Analysis** (no wallet).

| Check | Result |
|-------|--------|
| Genuine Researcher | `google/gemini-2.5-flash` |
| Genuine Strategist | `anthropic/claude-sonnet-4.6` → **NO_TRADE** |
| Mandate Fitter | **REJECTED** (authoritative on-chain mandate) |
| Risk Critic | `openai/gpt-5.2` → **ABSTAIN** |
| Final | **NO_TRADE** · `may_sign=false` · `dry_run=true` |
| Label | **LIVE AI — DRY RUN** |
| Settlement | Skipped (funded execution disabled) |
| Gate K recorded evidence | Still visible |

CLI corroboration (same BFF): HTTP 200 in ~44s; models Flash / Sonnet 4.6 / GPT-5.2; Fitter REJECTED; Critic REJECT; final BLOCKED; `may_sign=false`; `forced.portfolio_id=i-a-a4e7`.

## Quota behavior

| Probe | Result |
|-------|--------|
| Immediate re-POST | **429** `DEMO_CLIENT_COOLDOWN` |
| Status remaining | Global calls decreased after success (37 → 36) |
| Single-flight UX | Button disabled while “Running Live AI Analysis… (up to ~90s)” |

## Security verification

| Check | Result |
|-------|--------|
| Empty body demo-decide (no client portfolio) | PASS (OCI forces `i-a-a4e7`) |
| `allow_execute` / override on demo-decide | **403** `demo_forbidden_field` |
| `use_llm` on `/gate-j/decide` | **403** `use_demo_decide_for_live_ai` |
| Gate K execute | **403** not allowlisted |
| Bundle secrets (`sk-or-v1-`, `OPENROUTER_API_KEY`, `NIO_API_BASE`, OCI IP) | **absent** |
| Spoofable browser XFF | Not forwarded |

## Tests / build

- `npm test` — **31/31** passed  
- `npm run build` — success (with `VITE_PUBLIC_LIVE_AI=true`)

## Remaining notes

- Hobby plan commercial caveat still applies.
- Vercel function `maxDuration=100` covers OCI’s 90s demo timeout.
- No new Sepolia / Gate K trade executed by these tests.

## Screenshot

`docs/screenshots/nio-live-ai-dry-run.png` (copied from browser capture when available)
