# Hackathon alignment — near-intent-one

Date: 2026-11-09  
Selected tracks: `defi`, `security`, `agents`  
Official sources: [HACKATHON.md](https://nearhackathon.com/HACKATHON.md), [near-hackathon-prompt-examples](../vendor/near-hackathon-prompt-examples/) (gitignored reference clone), [near/agent-skills](https://github.com/near/agent-skills)  
Product skills installed (isolated worktree only): `near-intents`, `near-api-js`, `near-dapp` → `worktrees/product/.agents/skills/`

**Architecture rule:** Track example projects (DCA vault, counterparty scorer, general contractor) are judging references only. Do not replace the existing NEAR MPC-governed autonomous trader.

**Claim hygiene (from DECISION.md):** trusted-attestor ≠ Tidepool maker verify; revoke ≠ invalidating already-exported EVM signatures; Tidepool ≠ production 1Click.

---

## Judge-facing demo expectations (cross-track)

From official setup + track prompts + submission rules, judges (AI screeners + humans) need:

1. **Real quote previews** — `dry: true` 1Click/Tidepool quotes without requiring funds.
2. **Settlement-state visibility** — where funds sit; statuses including `SUCCESS` / `FAILED` / `REFUNDED` / in-progress.
3. **Security rejection demos** — live or scripted on-chain rejects (bad destination, expired attestation, post-revoke propose, preimage mismatch).
4. **Autonomous spending under policy** — agent spends without per-trade owner allowlisting; owner sets mandate once.
5. **Evidence receipts** — NEAR + EVM explorer links, operation ids, digests, mandate epoch.
6. **Reproducible judge instructions** — README "do X → see Y"; public repo; X demo post with video; no secrets.

Deadline: **2026-11-14T23:59:00Z**. One submission; agent must show payload and wait for human OK.

---

## Alignment matrix

| Dimension | Official track expectations | Gates B–E already demonstrated | Gate F is implementing | Product UI still needs to demonstrate | Missing submission evidence |
| --- | --- | --- | --- | --- | --- |
| **`defi` — Unstoppable DeFi** | Trading agents settle across chains via **NEAR Intents** + **Chain Signatures**; quotes → deposit → status; show where funds sit; dry-run; small UI with explorer links; stretch: contract owns signing path | **B** contract-owned MPC sign (`trading/v1/…`); **C** EIP-191 digest + Tidepool verifier accepts sig; **D** funded Sepolia `ORIGIN_CHAIN` USDC→wNEAR **SUCCESS** (`0x67fde88c…`); deposit-address substitution rejected | **F1** V2 quote attestation binds chain/token/amounts/recipient/refund/deadline/quote id/min out + EIP-155 fields; **F4** one unattended quote→sign→broadcast→settle→reconcile under frozen policy | Live **dry quote preview** panel; **settlement timeline** (Reserved → Signed → SUCCESS/FAILED/REFUNDED); fund-location labels (Sepolia USDC / deposit addr / intents balance); explorer deep-links; dry-run mode for judges with no funds | Hosted or local demo URL; README numbered try-it steps for quote+status; optional mainnet Intents note (Q-007: no Intents testnet) |
| **`security` — AI Security & Defense** | Spending limits + **policy engine**; refuse bad spend; scoped agent authority; attack demo that a prompt-injected agent cannot pay a bad address; explain key limits | **B** revoke blocks **new** MPC signing; **D** non-allowlisted deposit rejected; **E1** expired/untrusted attestation rejected; **E2** `tx.to`/`amount` mismatch + legacy agent commitment rejected; **E3** post-revoke propose B rejected (A already signed still executes — limitation recorded) | **F1** attestor refuses arbitrary agent destinations (must match quote deposit); replay/duplicate attestation tests; **F2** reconcile pending exposure + narrow owner cancel/nonce replace after revoke; **F3** Ledger owner `set_policy`/`revoke` (or BLOCKED with access-key audit) | **Security rejection gallery** wired to live views/scripts (bad deposit, expired quote, revoked mandate, preimage mismatch); clear copy of E3 limitation; mandate/exposure dashboard (`revoked`, epoch, reserved pending) | Attack-demo script log path linked from UI/README; Ledger proof artifact when F3 completes; never claim Tidepool maker on-chain verify |
| **`agents` — Agent Economy** | Agent earns/spends under budget; payments via crypto or Intents; **receipt per spend**; explain how agent holds keys and what it cannot do without owner | Agent account proposes; **policy contract** (not agent) requests Chain Signature; fabricated settlement rejected (Gate B); unattended quote auth without per-deposit allowlist (**E1**) | **F4** full unattended cycle under existing owner policy (no mid-cycle `set_policy`); attestor trust model documented on receipt | **Autonomous spend console**: agent action → quote → attestation → propose → MPC → broadcast → status → receipt card; budget/limits from on-chain policy; “what agent cannot do” panel (no revoke, no owner ops, no alternate digest) | One complete F4 receipt in `evidence/live/` surfaced in UI; judge path to replay without owner key |
| **Submission / judging process** | Public repo; README for AI judge; X post `@NEARProtocol` `#NEARHackathon` + **video**; tracks array; mainnet payout account; consent; submit once before deadline | Internal evidence packs B–E in `EVIDENCE.md` + `evidence/live/` (local; live JSON gitignored) | F1–F4 PASS/FAIL/BLOCKED in evidence (in progress; do not fabricate) | Judge dashboard that surfaces **existing** evidence receipts + reproducible commands; no marketing copy | Public GitHub URL; X demo post URL; mainnet `nearAddress`; team metadata; LICENSE; scrub secrets; curated public evidence subset or reproduction scripts |

---

## Track requirements → our product (not the example apps)

### From `tracks/01-defi.md` (keep architecture)

| Official requirement | Our mapping |
| --- | --- |
| 1Click/Intents quotes, deposits, status incl. REFUNDED/FAILED | Tidepool sandbox + policy settlement/reconcile; UI status machine |
| Show where funds sit at every step | MPC EVM identity → deposit address → intents credit |
| Small web UI + explorer links | `apps/web` judge dashboard |
| Dry-run real quotes | UI `dry: true` quote preview |
| Stretch: contract + Chain Signatures | **Already core** — policy contract owns MPC path |

### From `tracks/06-security.md` (keep architecture)

| Official requirement | Our mapping |
| --- | --- |
| Allow / warn / block before spend | On-chain require (block) + UI surface of rejects; warn = E3 limitation / attestor trust |
| Scoped agent authority | Agent FC path to policy methods only; owner mandate controls |
| Attack demo: bad pay stopped | Scripted + UI replay of deposit substitution / attestation failures |
| Explain key limits in README | Document: revoke ≠ cancel exported ECDSA; attestor trust root |

### From `tracks/07-agents.md` (keep architecture)

| Official requirement | Our mapping |
| --- | --- |
| Spend inside owner budget/limits | `max_trade_value`, assets, slippage, mandate epoch |
| Payments via Intents / crypto | ORIGIN_CHAIN deposit signed by MPC |
| Receipt per task | Evidence JSON + UI receipt (quote id, digests, txs, settlement) |
| Explain key custody | Contract-derived key; agent never holds MPC root; owner revoke/policy |

---

## Gate status snapshot (do not regress)

| Gate | Status | Product relevance |
| --- | --- | --- |
| B Contract MPC + revoke blocks new sign | PASS | Security demo + agents custody story |
| C EIP-191 + verifier accept | PASS | Defi Intents authenticity |
| D Funded ORIGIN_CHAIN SUCCESS | PASS | Defi settlement proof |
| E1 Dynamic quote auth (trusted attestor) | PASS (Tidepool direct verify BLOCKED) | Unattended agents; disclose trust model |
| E2 On-chain EIP-155 digest binding | PASS | Security preimage demo |
| E3 Sign→revoke→broadcast A still executes | PASS + limitation | Must show honestly in UI |
| F1–F4 | In progress (separate stream) | Unblocks Copilot/strategy; UI consumes results, does not edit Gate F |

---

## Skills policy (product worktree)

| Skill | Why installed | Why not others |
| --- | --- | --- |
| `near-intents` | Quote/status/deposit UX patterns for dry preview + settlement | — |
| `near-api-js` | View/call policy contract from web | — |
| `near-dapp` | Vite/React + wallet patterns for judge UI | — |
| `near-smart-contracts` / `near-kit` / `near-ai-cloud` / audit / cli | Not installed here — contracts/Gate F stay isolated | |

---

## Product UI implementation focus (next)

Priority surfaces in `apps/web` (no contract/Gate F edits):

1. Dry quote preview (real HTTP quote, no broadcast).
2. Mandate + pending exposure + settlement state from chain views.
3. Security rejection demos (link evidence + optional live view).
4. Autonomous spend receipt viewer (bind to Gate D/E/F artifacts).
5. Judge instructions page: numbered do-X-see-Y against testnet.

Out of scope for this UI stream: modifying `contracts/`, Gate F scripts/evidence, signing infrastructure, or inventing hashes.
