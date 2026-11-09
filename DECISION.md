# DECISION — near-intent-one gates

Date: 2026-11-09  
Evidence: `EVIDENCE.md` + `evidence/live/`  
Rule: no fabricated hashes; failed receipts ≠ SUCCESS; Tidepool ≠ production 1Click.

## Gate results

| Gate | Status | Notes |
|------|--------|-------|
| **B** Contract-controlled Chain Signature | **PASS** | Preserved |
| **C** EIP-191 intent + verifier | **PASS** | Preserved |
| **D** Funded ORIGIN_CHAIN swap | **PASS** | Preserved |
| **E1** Dynamic quote auth | **PASS** | Preserved |
| **E2** EIP-155 preimage binding | **PASS** | Preserved |
| **E3** Revoke vs broadcast | **PASS** | Exported ECDSA survives NEAR revoke |
| **F1** Trust / signing boundary | **PASS** | Trusted attestor (not Tidepool maker verify) |
| **F2** Revocation recovery | **PASS** | Reconcile + narrow cancel; E3 preserved |
| **F3** Ledger owner proof | **BLOCKED** | No physical Ledger session in agent env |
| **F4** Unattended trade cycle | **PASS** | Full settle under frozen policy |
| **G** Ledger + accounting harden | **BLOCKED** | Accounting/reconciler PASS; Ledger hardware BLOCKED |
| **H** Hardware + agent backend | **BLOCKED** | H2/H3/H4 + upgrade auth PASS; Ledger still BLOCKED |
| **Ledger-only owner keys** | **BLOCKED** | Software FullAccess still present |
| **Mainnet trading** | **BLOCKED** | Requires explicit approval |

## Gate F detail

### F1 — PASS (delegated trust)

- Attestor **refuses** agent `requestedDeposit` ≠ `quote.depositAddress`.
- `QUOTE_AUTH_V2` binds: deposit, amounts, assets, min_out, deadline, token, chain_id, recipient, refund_to, correlation_id, quote_hash, max_gas_price, gas_limit.
- On-chain EIP-155 digest matches; replay and gas_limit mismatch rejected.
- **Limitation:** Tidepool maker pubkey unpublished → **not** independently verified maker signatures. Trust model = **owner-pinned attestor**.

### F2 — PASS

- E3 limitation kept: prior EVM sigs survive NEAR revoke.
- `reconcile_pending(operation_id, terminal_state, evidence_hash)` — evidence required; API success alone is not terminal.
- `owner_request_cancel_signature` only while `revoked`, Sepolia, 0-value **self**-transfer, gas_limit ≤ 100k — cancel broadcast [`0x7a34a8c7…`](https://sepolia.etherscan.io/tx/0x7a34a8c751ae60db536b1a80beb7aa009839a34bb8f647067499dc2591f81056) status `0x1`.
- Distinguishes **signing revocation** (blocks new MPC) from **economic revocation** (reconcile to zero reserved exposure).

### F3 — BLOCKED

- Owner account still has **1 software FullAccess** key.
- Physical Ledger `set_policy` / `revoke` not demonstrated in this environment.
- Prepared flow documented; never request seed phrases.

### F4 — PASS

Unattended cycle (no mid-cycle `set_policy` / deposit allowlist):

Agent quote → attestor validates → `propose_quoted_evm_transfer` → MPC sign → Sepolia broadcast [`0xe49d5ff8…`](https://sepolia.etherscan.io/tx/0xe49d5ff80fd8533d9719969b50647e49c99845d79fac27d39578e4003552e558) → Tidepool **SUCCESS** → `reconcile_pending(Success, nearTxHash)`.

NEAR settlement txs include `B6uEASppdZmHM25RxiF5U9rs3K98eEkPj77Z8JhGcKfY`.

Trust model on the evidence chain: **trusted_attestor_not_tidepool_maker**.

## Gate G detail

See `GATE_G.md`.

- F2 leftover `reserved=1000000` / `unresolved=1` traced to abandoned never-signed `f1-1794229262329` (**correctly pending**, not false Success). Reconciler Expired → `reserved=0` (`9MeJmCE5b1nzcdK6fMMft8vMx6Nx5GizYYWQZDDDzqUE`).
- `reconcile_pending` stores `evidence_hash` only; `verified_onchain:false`. Trust = owner or owner-pinned reconciler after off-chain receipt check.
- Narrow reconciler (`nio-c-agent-857107.testnet`) can settle pending; cannot `set_policy`/`revoke`.
- Ledger add-then-remove software FullAccess flow prepared; physical txs **BLOCKED**.
- F1 attestor limitation + E3 post-revoke EVM execution **preserved**.

## Gate H detail

See `GATE_H.md`.

- **H1 Ledger BLOCKED** — no physical device; software FullAccess remains.
- **H1 upgrade authority PASS** — policy contract FullAccess consolidated to owner key (dedicated contract software key removed). Compromised owner software key can still upgrade until Ledger.
- **H2 PASS** — reconciler `nio-c-recon-857107.testnet` ≠ agent; off-chain receipt checks before reconcile; never deadline-only Expire of Signed ops.
- **H3 PASS** — deterministic TRADE decision + live settle [`0xba28b97b…`](https://sepolia.etherscan.io/tx/0xba28b97b8102dc160db6d89243c67e14538aef1cc0f415f7fbb2f9d903446d09); reconciler reconcile `CFj1Q12DVjEs6SCC2iATjju89hDK6Lzaz5TLBmauEeZ1`.
- **H4 PASS** — local git + `packages/agent-api` interfaces; `apps/web` untouched; no public push.

## Product unlock

**F1 + F4 safe path works** under delegated attestor trust. Parallel product work is unblocked:

- Typed policy compiler  
- Conversational policy Copilot  
- Minimal historical replay  
- Judge-facing dashboard  

Constraints that remain:

- Do not claim Tidepool-maker-verified quotes until maker pubkey is pinned and verified.
- Do not claim instant cross-chain cancellation; E3/F2 show exported ECDSA survives NEAR revoke (cancel is a **nonce race**, not cryptographic erase).
- No mainnet trading without explicit approval.
- F3 Ledger-only ownership still required before production-hardening claims.
