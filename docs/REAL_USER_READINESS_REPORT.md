# NIO — Real-User Trading Readiness Report

**Date:** 2026-11-11 (pre-Ledger sprint)  
**Scope:** One real Ledger/wallet-controlled **TESTNET** owner lifecycle  
**Public demo:** still operating independently at https://near-intent-one.vercel.app  
**Backend:** https://nio-api-hack26.duckdns.org/v1  

**Verdict:** NOT production-ready. Non-funded backend path is largely ready; physical Ledger NEP-413 + funded trial remain. Public demo success ≠ real-user readiness.

---

## 1. Real-user readiness matrix

| Capability | Status | Notes |
|------------|--------|-------|
| Ledger connectivity | **PARTIAL** | WebHID Ledger client + wizard (`apps/web/src/ledger/*`); works for NEAR **tx** signing. No NEP-413/message sign yet. |
| Ledger transaction approval | **PARTIAL** | `set_policy` / revoke / add-key flows exist in wizard; Gate G physical Ledger proof historically BLOCKED. |
| Wallet-owner challenge/response auth | **PARTIAL → backend ready** | NEP-413 `/v1/owner/challenge|verify|session` + security suite (deterministic keys). Concurrent verify serialized. Frontend Ledger NEP-413 still needs home checklist. |
| Personal portfolio creation | **PARTIAL** | register / request_provision / lookup+mine APIs ready; self-serve WASM deploy gated (`GATE_I_SELF_PROVISION=0`). |
| Owner-policy deployment | **PARTIAL** | Per-user policy contracts via provision script; not self-serve. |
| Personal mandate update / revocation | **PARTIAL** | On-chain `set_policy` / pause / revoke via owner key; API does not forge these. UI gated on owner session. |
| Funding + balance hydration | **PASS** | Deposit address + live Sepolia/intents balance reads. |
| Trade authorization | **PARTIAL** | Mandate hydrate + Gate K safety; API still requires service API key + `GATE_K_ALLOW_SIGN` + operator confirm triad. |
| Deterministic economic viability | **PASS** | Fitter `ECONOMIC_NOT_VIABLE` fail-closed. |
| Independent Critic veto | **PASS** | Critic REJECT/ABSTAIN cannot be cleared by APPROVE after fitter reject. |
| NEAR MPC signing | **PARTIAL** | `propose_quoted_evm_transfer` + `request_signature` in Gate K execute; leaves `SIGNED_PENDING_BROADCAST`. |
| Sepolia broadcasting | **PARTIAL** (worker OFF) | `settlementWorker.mjs` + `settle.mjs` mock-tested; live broadcast **disabled** (`GATE_K_SETTLEMENT_WORKER=0`). |
| Tidepool/Intents settlement | **PARTIAL** | Quote path live; worker advances post-MPC states when enabled; dry-run default. |
| Reconciliation | **PARTIAL** | Worker can reach RECONCILED when enabled; currently OFF. |
| Withdrawal and refund | **PARTIAL** | Quote + destination allowlist; submit needs owner/Ledger on-chain sign (`GATE_I_ALLOW_SERVER_OWNER_SIGN=0`). Owner session now required. |
| Recovery after interrupted execution | **PARTIAL** | Pending list only; no auto broadcast resume. |
| Durable idempotency / nonces | **PASS** (store-local) | Execution keys + nonce tracking in `store.mjs`. |
| AuthZ boundaries | **PARTIAL → improved** | Service API key ≠ owner auth; owner session enforced on portfolio create / withdraw; public BFF still must not expose owner routes. |

---

## 2. Exact functionality already working

- Trusted OCI HTTPS + Vercel BFF health/demo path.
- Gate J dry-run decide + public `demo-decide` with quotas / kill switch / may_sign=false.
- On-chain mandate hydrate + revalidate (paused/revoked/epoch).
- Fitter economics + Critic veto + Gate K edge buffer.
- Single-flight / max-trades / pending exposure checks (fitter + safety).
- Historical Gate K acceptance-override evidence preserved (script-only; not API).
- Ledger wizard for device connect + NEAR tx approval (local).
- Balance hydration and deposit address issuance for provisioned portfolios.

## 3. Missing features / gaps

1. **Frontend owner session** — Ledger/wallet NEP-413 `signMessage` → verify → `X-NIO-Owner-Session` (see `docs/LEDGER_HOME_TEST_CHECKLIST.md`).
2. **Self-serve portfolio factory** — still operator `scripts/gate-i-provision.mjs` (`GATE_I_SELF_PROVISION=0`).
3. **Enable settlement worker** only for an approved trial (`GATE_K_SETTLEMENT_WORKER=1`, dry-run off).
4. **Normal (non-override) funded AI trade** — never proven; economics often BLOCKED (correct).
5. **Ledger message signing** (challenge) — must use NEP-413 INS 0x07, not tx-only.
6. **Owner BFF** — must not allowlist `/owner/*`, Gate K execute, or withdraw submit on public demo BFF.
7. **Reconciler health depth** — currently shallow “booted” flag.
8. **OCI E2.1.Micro reliability** — dnf OOM confirmed + mitigated; guest-hang class still needs OCI RESET (see `docs/OCI_STABILITY_SPRINT_REPORT.md`).

## 4. Completed fixes (this stage)

| Fix | Detail |
|-----|--------|
| Owner challenge/verify/session API | `packages/services/ownerAuth.mjs` + routes on `api-server.mjs` |
| Concurrent verify race | Serialized exclusive verify — one winner / `challenge_replay` |
| Owner session on portfolio create / withdraw / personal reads | Rejects `claimed_owner`-only |
| Owner read APIs | `/owner/portfolios`, `/portfolios/mine`, provision-requests, `lookup|status` |
| Settlement worker (OFF) | Mock lifecycle tests; no live broadcast |
| OCI stabilize | Mask dnf-makecache + PCP; MemoryHigh/Max; flags pinned OFF |
| Tests | `ownerAuth(.security).test.mjs`, `settlementWorker.test.mjs`, provision/withdraw/lifecycle |
| Chat 2 / home Ledger | `docs/OWNER_AUTH_API.md`, `docs/LEDGER_HOME_TEST_CHECKLIST.md` |

**Not done:** funded broadcast, self-serve provision, physical Ledger NEP-413 proof, mainnet enablement.

## 5. Required Chat 2 frontend changes

See `docs/OWNER_AUTH_API.md`.

- Implement challenge → device sign → verify → session header.
- Add Ledger/wallet **message** signing (not only tx).
- Owner-authenticated personal UX separate from public demo.
- Do **not** allowlist `/owner/*`, `/gate-k/*` execute, or withdraw submit on public BFF.

## 6. New / changed API contracts

| Endpoint | Change |
|----------|--------|
| `POST /v1/owner/challenge` | **NEW** |
| `POST /v1/owner/verify` | **NEW** |
| `GET /v1/owner/session` | **NEW** |
| `POST /v1/owner/logout` | **NEW** |
| `POST /v1/portfolios` | Requires `X-NIO-Owner-Session` matching `owner_account` |
| `POST …/withdrawals[/quote]` | Requires owner session matching portfolio owner |
| CORS | Allows `x-nio-owner-session` |

## 7. Security and ownership verification

- `claimed_owner` is **not** authentication.
- `GATE_I_API_KEY` is **service** auth only.
- Owner proof: live NEAR access-key membership + ed25519 challenge signature bound to domain/account/network/nonce/expiry; single-use.
- Demo path isolated (`demo-decide`, BFF strips override keys).
- Withdraw still requires on-chain owner method; server owner-sign remains off.

## 8. Testnet trading readiness

**Not ready for unsupervised funded trading.**

Blockers for one **normal** (non-override) small trade:

1. Qualifying AI edge (Fitter + Critic + Gate K buffer) — may correctly BLOCK.
2. `GATE_K_ALLOW_SIGN=1` + operator confirm (explicit).
3. `GATE_K_ALLOW_MULTI=1` if first-test slot already used.
4. Hosted broadcast/settle worker.
5. Owner-authenticated portfolio (not demo).

No funded trade was executed in this stage.

## 9. Withdrawal readiness

**Partial.** Quote + allowlist + owner session OK. Actual withdraw needs Ledger/wallet `owner_request_withdraw_signature`. Limitation: **already-produced EVM ECDSA signatures cannot be recalled** by revoking the NEAR mandate — UX must disclose this.

## 10. Mainnet migration requirements (no execution)

- Separate mainnet policy deploy + `v1.signer` (not testnet signer-prod).
- Distinct derivation paths / MPC addresses; never reuse testnet paths.
- Mainnet chain IDs, gas assets, Intents/1Click registries.
- Isolated credentials, OCI/host sizing beyond E2.1.Micro, monitoring/alerts/backups.
- Independent security review / audit before serving third parties.
- Compliance review before multi-user funds.
- **Do not enable mainnet signing in this codebase path without separate authorization.**

## 11. Critical production launch blockers

1. No hosted post-sign broadcast/settle.
2. No self-serve audited provision + Ledger-only ownership proven E2E.
3. Frontend owner auth not wired.
4. Always Free micro reliability risk (prior hang).
5. Acceptance-override history ≠ normal approval proof.
6. Security audit / threat model for custody + MPC export.
7. Mainnet isolation incomplete by design until separate project.

## 12. Test and build results

```text
node --test packages/services/ownerAuth.test.mjs packages/gate-k/gate-k.test.mjs \
  packages/gate-j/fitter.test.mjs packages/gate-j/hydrate.test.mjs
→ 68 pass / 0 fail
```

Live: `POST https://nio-api-hack26.duckdns.org/v1/owner/challenge` → 200 with domain-bound message.

## 13. Unauthorized transactions

**Confirmed:** no mainnet activity; no new funded testnet broadcast; no Gate K sign enablement; no acceptance override; no withdrawals executed. Changes are auth/hardening/docs/tests only.
