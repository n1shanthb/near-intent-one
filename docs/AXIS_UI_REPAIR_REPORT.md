# NIO AXIS UI repair report

**Date:** 2026-11-10  
**Production URL:** https://near-intent-one.vercel.app  
**Status:** UI repair PASS · Live AI BLOCKED by OCI host downtime (not by frontend wiring)

## 1. Root cause — black-on-black

`apps/web/src/style.css` defines a dark console theme (`--bg/#070b09`, `--panel/#121a16`, lime `--accent/#b8f24d`). AXIS styles then force `color:#000` on text. Legacy cards (Decision Journey, Fitter, Gate K) kept dark panel backgrounds → black text on near-black surfaces. Lime accent was also used for body links on white.

**Fix:** Import `style.css` before AXIS CSS; remap CSS variables under `.axis-layout` / `.legacy-embed` to the light AXIS palette; semantic badges/links use cobalt / dark green / amber / red.

## 2. Root cause — outdated API status copy

Judge-facing strings still said “Gate I unavailable”, “Gate J not hosted”, “Chat 1”, and `VITE_GATE_*` setup instructions. Separately, production BFF could not reach OCI (`upstream_unreachable` / now `upstream_timeout`) because **the OCI host itself is unreachable on 22/80/443** from this environment and from Vercel.

**Fix:** Default API base to `/api/v1`; humanize upstream failures; GateIBanner / Agent / Portfolio / Security / Mandate use public-demo language. BFF GET timeout shortened to 8s so the UI fails closed quickly. Fixtures fall back to local deterministic runs when the API is down.

## 3. Pages repaired

| Page | Change |
|------|--------|
| AI Agent | Cobalt live panel, compact pipeline, white journey/fitter, fixed scenario cards, Gate K summary only |
| Overview | Accurate API status, dual CTAs, technical ids demoted |
| Portfolio | Demo summary first; personal controls collapsed |
| Evidence | Proof dashboard with override disclosure + hash copy/explorer |
| Transactions | Tabbed activity + detail pane |
| Mandate | Overview / Composer / Preview tabs; JSON collapsed |
| Security | Posture cards; owner actions disabled for public visitors |

## 4. Screenshots

| File | Notes |
|------|-------|
| `docs/screenshots/nio-repair-overview-1440.png` | Cobalt hero + CTAs |
| `docs/screenshots/nio-repair-agent-fixture-1440.png` | Readable pipeline after fixture A |
| `docs/screenshots/nio-repair-evidence-1440.png` | Gate K proof dashboard |
| `docs/screenshots/nio-repair-portfolio.png` | Demo-first portfolio |

## 5. Accessibility / contrast

Manual screenshot inspection after remapping: white panels, dark ink, muted gray secondary, cobalt links, dark semantic badge text. Automated axe not run in this pass; WCAG AA targeted for body/controls.

## 6. Production health / Live AI

| Check | Result |
|-------|--------|
| `GET /api/v1/health` | `upstream_timeout` (OCI host down) |
| `GET /api/v1/gate-j/demo-status` | `upstream_timeout` |
| Direct OCI `https://nio-api-hack26.duckdns.org` | Connection timeout |
| SSH `opc@129.225.72.169:22` | Timeout |
| Fixture Scenario A | PASS (local deterministic) |
| Live AI dry-run | Not attempted — quota + host down; UI correctly disabled |

## 7. Build / test

- `npm test` (apps/web): **31/31**
- `npm run build`: success
- Vercel production deploy: READY → https://near-intent-one.vercel.app

## 8. Deployed URL

https://near-intent-one.vercel.app

## 9. Remaining issues

1. **OCI API host is down** (ports 22/80/443 timeout). Live AI and live balances cannot recover until the instance/firewall/Caddy stack is restored. Frontend wiring to `/api/v1` is intact.
2. Portfolio live balance table empty while API is unreachable (honest recorded residual shown).
3. Ledger wizard still embeds legacy styles under Security (light-remapped).
4. Pixel-perfect AXIS chart density still not claimed.

## 10. No new trades

No Gate K / Sepolia execution, no signing, no acceptance override. Fixture runs only. `GATE_K_ALLOW_SIGN` remains off.
