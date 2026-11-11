# Personal Testnet Trading Infrastructure

**Date:** 2026-11-11  
**Signing:** OFF (`GATE_K_ALLOW_SIGN=0`)  
**Settlement worker:** OFF / dry-run (`GATE_K_SETTLEMENT_WORKER=0`, `GATE_K_SETTLEMENT_DRY_RUN=1`)  
**Autonomous:** OFF  
**Public execution BFF:** not enabled  

## Funded testnet trial readiness: **BLOCKED**

Infrastructure is prepared for one explicitly authorized normal-approval testnet trade, but **must not** run until operator approval of portfolio, network, token, max amount, and purpose. Signing and live broadcast remain gated.

---

## 1. Owner authentication compatibility

- **Standard:** NEP-413 (tag `2147484061`, Borsh payload, SHA-256, ed25519).
- **Recipient** = domain; **message** embeds account/network/challenge_id/expiry; **nonce** = 32 random bytes; single-use; FullAccess key required.
- Raw UTF-8 signing **removed** as production path (was incompatible with Ledger/wallet-selector).
- Details: `docs/OWNER_AUTH_API.md`.

## 2. Personal portfolio provisioning

| Action | Status |
|--------|--------|
| `register` existing owner-controlled policy | **Implemented** — on-chain owner check, isolated store row, demo ban |
| `request_provision` / `create` | **Implemented** — durable request + placeholder portfolio |
| Full self-serve WASM deploy | **Gated** `GATE_I_SELF_PROVISION=0` — needs funded provisioner |

Demo `nio-c-*` cannot create/control personal portfolios.

## 3. Broadcast / settlement worker

Lifecycle: `AUTHORIZED → … → POLICY_APPROVED → MPC_SIGNED → BROADCAST → CONFIRMED → SETTLEMENT_PENDING → SETTLED → RECONCILED`  
(+ honest `FAILED` / `BLOCKED`).

- `SIGNED_PENDING_BROADCAST` normalized as **MPC_SIGNED** (signature ≠ settlement).
- Worker: `packages/services/settlementWorker.mjs` + `packages/gate-k/settle.mjs`.
- **Never re-signs** if `sepolia_tx` or signed status present.
- Default **disabled**; dry-run suppresses `eth_sendRawTransaction`.

## 4. Owner-bound trading

- `AI_TESTNET_EXECUTION` requires API key **and** `X-NIO-Owner-Session` matching portfolio/mandate owner.
- `acceptance_override` **rejected** on Gate K API.
- Fitter / Critic / pre-sign (`signing_revoked`, USDC, ETH gas) fail closed.
- Production signing remains OFF.

## 5. Withdrawal lifecycle

- Prepare → Ledger/wallet `owner_request_withdraw_signature` → attach `near_tx_hash`.
- Status tracking in store; ECDSA recall limitation documented in API responses.
- Server owner-sign remains OFF.

## 6. OCI reliability

- Settlement worker separate interval; `unref()`; max 2 items/tick.
- AI LLM spend still capped; settlement does not share OpenRouter path.
- Evidence-backed stabilize (2026-11-11): mask `dnf-makecache` (confirmed OOM victim ~330 MiB RSS), mask/disable PCP (`pmcd`/`pmie`), cgroup MemoryHigh/Max on `nio-gate-i`, settlement/self-provision env pinned OFF. Details: `docs/OCI_STABILITY_SPRINT_REPORT.md`.
- E2.1.Micro remains a **launch blocker** for real-money multi-user; in-guest watchdog cannot heal a fully hung OS.

## 7. Owner read APIs (Chat 2)

- `GET /v1/owner/portfolios` · `GET /v1/portfolios/mine` · `GET /v1/owner/provision-requests`
- `POST /v1/portfolios` `action=lookup|status` → `ready` / `awaiting_provision` / `no_portfolio`
- Personal portfolio GET/balances/deposits require matching owner session
- Home Ledger steps: `docs/LEDGER_HOME_TEST_CHECKLIST.md`

## 8. Tests vs on-chain proof

| Coverage | Result |
|----------|--------|
| NEP-413 / owner auth security / provision / withdraw / settlement worker / lifecycle / Gate K unit | Automated mocks — **PASS** |
| Funded Sepolia broadcast / Tidepool settle | **Not proven** this stage (intentionally gated) |

## 9. Remaining blockers for funded trial

1. Operator sets portfolio + max amount + purpose; enable `GATE_K_ALLOW_SIGN=1` temporarily.  
2. Enable settlement worker with `GATE_K_SETTLEMENT_DRY_RUN=0` only for that trial.  
3. Owner NEP-413 session from Chat 2 + Ledger/wallet.  
4. Qualifying Fitter+Critic economics (no override).  
5. Ready personal portfolio (`register` or provisioned).  
6. Sufficient Sepolia USDC + ETH gas on MPC address.

## 10. Unauthorized transactions

**Confirmed none:** no mainnet; no live broadcast; signing off; no acceptance override; no withdrawals executed on-chain by this change set.
