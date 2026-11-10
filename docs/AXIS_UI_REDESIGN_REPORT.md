# NIO × AXIS UI redesign report

**Production URL:** https://near-intent-one.vercel.app  
**Status:** Deployed — high-fidelity AXIS visual system adapted for NIO  
**Date:** 2026-11-10

## Architecture preserved

- Frontend: Vercel SPA + BFF (`/api/v1/*`)
- Backend: `https://nio-api-hack26.duckdns.org/v1`
- Live AI: `POST /gate-j/demo-decide` · `GET /gate-j/demo-status`
- Gate K signing / autonomous mode: still OFF
- No new Sepolia trades during redesign

## Files changed (primary)

| Area | Path |
|------|------|
| Landing | `apps/web/src/components/nio/Landing.tsx`, `LandingPreview.tsx`, `NioLogo.tsx` |
| Workspace | `WorkspaceShell.tsx`, `OverviewPage.tsx`, `AgentWorkspace.tsx`, `nav.ts` |
| App shell | `apps/web/src/App.tsx`, `main.tsx`, `index.html` |
| Styles (MIT-adapted AXIS) | `apps/web/src/styles/landing.css`, `axis.css`, `workspace-theme.css`, `nio-overrides.css` |
| Notices | `apps/web/src/styles/THIRD_PARTY_NOTICES.md` |
| Reference (local only) | `.axis-ref/` (gitignored) |

## Screenshots

| Shot | Path |
|------|------|
| AXIS landing 1440 | `docs/screenshots/axis-landing-1440.png` |
| NIO landing 1440 | `docs/screenshots/nio-landing-1440.png` |
| NIO landing 390 | `docs/screenshots/nio-landing-390.png` |
| NIO overview 1440 | `docs/screenshots/nio-overview-1440.png` |
| NIO AI Agent 1440 | `docs/screenshots/nio-agent-workspace-1440.png` |

## Visual comparison findings

**Matches closely**

- White paper landing + cobalt / yellow / orange collage language
- Geist-scale display typography, black pill CTAs, signal strip
- Four-tab process section with vivid panels
- Proof paper + FAQ accordion + yellow final CTA
- Workspace: 224px sidebar, cobalt selected nav, 60px topbar, `#f5f6fa` canvas
- Segmented wallet control geometry; network chip

**Remaining differences (not claiming pixel-perfect)**

- NIO wordmark/logo (intentional; AXIS mark not reused)
- Hero preview shows NIO pipeline card instead of AXIS chart plots
- Portfolio / Mandate / Transactions still use legacy panel markup inside AXIS chrome (`legacy-embed`) — spacing denser than pure AXIS tables
- Some AXIS chart/analytics pages have no NIO equivalent (by design)
- Full Playwright side-by-side diff automation not checked into CI yet

## Feature verification

| Feature | Result |
|---------|--------|
| Landing → Open workspace | PASS `/overview` |
| Sidebar nav + collapse + mobile menu | PASS |
| AI Agent Live AI button + demo-status | PASS (enabled after health) |
| Fixtures + recorded OCI trace + Gate K honesty | PASS |
| Wallet optional for evidence / dry-run | PASS |
| BFF allowlist / no signing UI | PASS |
| Unit tests | 31/31 |
| Production build | PASS |

## Live AI

Public dry-run remains wired to demo-decide (prior enablement report). This redesign did not re-spend a full OpenRouter run after UI deploy; status shows demo available with remaining global quota.

## No new transactions

Confirmed: redesign/deploy/browser checks did not execute Gate K signing or Sepolia trades.
