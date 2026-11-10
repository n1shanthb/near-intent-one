# NIO Vercel production deployment report

**Date:** 2026-11-10  
**Status:** PASS (public demo) — live OpenRouter button still gated

## 1. Deployment status

**PASS** for the judge demo path: public SPA + allowlisted BFF + trusted OCI HTTPS. Public live-AI (`NIO_PUBLIC_LIVE_AI`) remains **false** until shared rate limits are explicitly enabled.

## 2. Public Vercel HTTPS URL

https://near-intent-one.vercel.app

(SSO / Deployment Protection disabled for judge access.)

## 3. OCI HTTPS API hostname

`https://nio-api-hack26.duckdns.org/v1` (Let's Encrypt; verified without TLS bypass)

## 4. Vercel BFF routes implemented

Handler: `apps/web/api/index.ts`  
Rewrite: `/api/(.*)` → `/api` (required; non-Next catch-alls only match one segment)

Allowlisted:

| Method | Path |
|--------|------|
| GET | `/api/v1/health` |
| GET | `/api/v1/gate-j/health` |
| GET | `/api/v1/gate-j/scenarios` |
| GET | `/api/v1/gate-j/decisions` |
| GET | `/api/v1/gate-j/market` |
| POST | `/api/v1/gate-j/decide` |
| POST | `/api/v1/gate-j/fit` |
| GET | `/api/v1/portfolios/{i-a-a4e7\|i-b-a4e7}` (+ `/balances`) |

Server env (set in Vercel when Chat 1 is ready): `NIO_API_BASE`, `GATE_I_API_KEY`, optional `NIO_PUBLIC_LIVE_AI=true`.

## 5. Frontend build and test results

- `npm test` — **31/31 passed** (8 files)
- `npm run build` — **success** (`dist/`)

## 6. Public browser verification

| Check | Result |
|-------|--------|
| HTTPS trusted TLS on `*.vercel.app` | PASS |
| Home / Welcome loads | PASS |
| View Demo → Agent | PASS |
| Deep link `/activity`, `/welcome`, `/agent` | PASS |
| Gate I / Gate J health via BFF | PASS (`available` / online) |
| Fixture `POST /gate-j/decide` ADAPTED | PASS (`may_sign=false`) |
| Live AI button | Disabled (`NIO_PUBLIC_LIVE_AI=false`) |
| Recorded evidence + Gate K honesty | PASS |

## 7. Gate K evidence display

Verified on Agent + Activity:

- Badge: **LIVE AI EXECUTION — PROVEN**
- Warning: **AUTONOMOUS SAFETY APPROVAL — NOT PROVEN BY THIS OVERRIDDEN TRADE**
- Fitter `ECONOMIC_NOT_VIABLE`, Critic REJECT, override disclosed
- Sepolia tx link: `0x867717ff730678d9588a915879721d7d67a8b7826008dd140f228a3e813965fe`
- Override control **not** exposed publicly

## 8. Public security checks

| Probe | Result |
|-------|--------|
| `POST .../gate-j/decide` + `allow_execute:true` | **403** `funded_execution_forbidden` |
| `acceptance_override:true` | **403** `gate_k_execution_forbidden` |
| `use_llm:true` while live AI off | **403** `public_live_ai_disabled` |
| `/api/v1/gate-k/execute` | **403** not allowlisted |
| `/api/v1/portfolios/evil` | **403** not allowlisted |
| Upstream missing | **503** `upstream_not_configured` |
| Bundle secrets (`sk-or-v1-`, `OPENROUTER_API_KEY`, `NIO_API_BASE`, OCI IP) | **absent** |
| `GATE_I_API_KEY` string in bundle | Error-message text only (no secret value) |

## 9. Screenshots

- `docs/screenshots/nio-agent-gatek.png`
- `docs/screenshots/nio-gatek-evidence.png`
- `C:\Users\Nishanth\AppData\Local\Temp\cursor\screenshots\nio-activity-gatek.png`
- `C:\Users\Nishanth\AppData\Local\Temp\cursor\screenshots\nio-welcome.png`

## 10. Remaining optional follow-ups

1. Confirm OCI shared rate limits / OpenRouter budget, then set `NIO_PUBLIC_LIVE_AI=true` and redeploy if judges should run live dry-run AI.
2. **Hobby plan:** prize-bearing / commercial use may require Pro — do not assume Hobby permits commercial hosting.

## 11. No new trade executed

Post-TLS verification used only BFF health/fixtures/security probes. **No new Sepolia / Gate K trade was executed.** Gate K remains `allow_sign_env=false`, `autonomous_loop_env=false`.
