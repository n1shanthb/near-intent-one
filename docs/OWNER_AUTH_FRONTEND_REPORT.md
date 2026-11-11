# NIO Owner Auth Frontend — Delivery Report

**Date:** 2026-11-11  
**Frontend:** https://near-intent-one.vercel.app  
**Backend:** https://nio-api-hack26.duckdns.org/v1  
**Latest deploy:** `dpl_CMXgeVAiK52r69VJJCqrfdhmnPJN` (READY)

## Pre-Ledger sprint summary

Hardware approval was **not** requested. All work below is frontend / gateway / judge UX.

### Security (Priority 1)

- Removed `GATE_I_API_KEY` / hardcoded secret fallbacks from owner-auth gateway.
- Gateway **fail-closed** without dedicated `NIO_OWNER_AUTH_SECRET` (≥32 chars, must differ from API key).
- Secret set independently on Vercel Production + Preview (value not logged).
- HttpOnly + Secure + SameSite=Lax session cookie; CSRF Origin/Referer + double-submit cookie/header.
- Token stripped from verify JSON; tampered cookie → `no_owner_session`.
- Allowlist only: challenge / verify / session / logout / portfolios.
- Gate K execute remains blocked on public BFF (`proxy_path_not_allowlisted`).

### Owner UX (Priority 2)

- `/owner` + `/my-portfolio` state copy + recovery for WebHID, permission, NEAR app, version, FullAccess, reject, expiry, provisioning.
- Illustrative state guide explicitly marked **NOT A LIVE SESSION**.

### Judge / Live AI / Presentation (Priorities 3–5)

- Landing: **Start 60-second demo** + judge walkthrough + Ledger/AI/NEAR honesty grid.
- Live AI button requires health + demo-status + quota; fixtures preferred.
- Demo script: `docs/JUDGE_DEMO_SCRIPT.md`.

### Tests

- Web vitest: **45/45 PASS**
- Owner auth backend: **3/3 PASS**
- Production build: **PASS**
- Live probes: challenge 200 NEP-413; CSRF missing origin 403; `/api/owner-auth/gate-k` 403; `/api/v1/gate-k/execute` 403; demo-status enabled.

### Hardware-only remaining

Physical Ledger connect → NEP-413 approve → verified session → provisioned My Portfolio.

### Unauthorized transactions

**Confirmed none** this sprint: no funded txs, no Gate K sign, no acceptance override, no mainnet, no hardware claims.
