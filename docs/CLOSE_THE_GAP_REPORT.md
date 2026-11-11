# Close-the-gap sprint report

**Date:** 2026-11-11  
**Deadline context:** Nov 14, 2026  
**Confirmation:** **No funded transactions, no mainnet deployment, no Ledger signing occurred.**

---

## 1. Critical policy security findings and fixes

| Finding | Severity | Fix |
|---------|----------|-----|
| `max_gas_budget` not enforced on quoted EVM propose | High | Enforce `max_gas_price * gas_limit ≤ max_gas_budget` when budget > 0 |
| `any_eligible_token` could reach EVM sign path | Critical for funded | Hard-require `token_scope == allowlist` on `propose_quoted_evm_transfer` |
| Final swap `recipient` / `refund_to` not mandate-checked | High | Require both in `allowed_destinations` |
| Malicious agent post-approval recipient / payload swap | Mitigated (was partial) | Unit tests: `tx.to != deposit` rejected; unsigned recipient change rejected; digest contract-owned; `propose_trade` cannot use `0x` destinations; attestation replay blocked |

`request_signature` still signs **only** the stored `payload_commitment` (no agent-supplied digest). Direct contract calls cannot bypass these checks.

**ANY_ELIGIBLE_TOKEN remains NOT SAFE FOR FUNDED EXECUTION.**

Tests: `cargo test` → **28 passed**.

---

## 2. Production 1Click quote result

**DRY_QUOTE_OBTAINED** (real API, `dry: true`):

- Origin: `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near` (1 USDC)
- Dest: `nep141:wrap.near`
- Evidence: `docs/MAINNET_1CLICK_DRY_QUOTE_EVIDENCE.json`
- Deposit address: **none** (dry) — ERC-20 deposit authorization not claimed executable
- Funded quote / broadcast: **OFF**

Invalid refund formats fail closed with API message (`refundTo is not valid`).

---

## 3. Routes executable vs stubbed

| Route | State |
|-------|-------|
| NEAR Intents / 1Click | **Real dry quotes** + discovery/bind/status/reconcile helpers |
| EVM DEX (0x) | **Stub** — `UNSUPPORTED_ROUTE` |
| NEAR-native DEX | **Stub** — `UNSUPPORTED_ROUTE` |

Four-chain identities retained in policy allowlists / UI config. Prefer one real route over fake liquidity.

---

## 4. Updated WASM

| | |
|--|--|
| Path | `artifacts/mainnet/policy.wasm` |
| Size | **625565** bytes |
| SHA-256 | **aa301524d9cfa99cbf0948d8e65f5f137411d494da91805770314fc6801b0202** |
| Prior frozen | `6fd1912f…30d1` (624900) — **do not deploy** |

---

## 5–6. Ledger deployment readiness + NEAR estimate

See `docs/LEDGER_MAINNET_DEPLOY.md`.

- Recommend subaccount `policy.<ledger-owner>.near`
- Mainnet `storage_amount_per_byte = 1e19` → WASM storage **6.25565 NEAR**
- **Recommended minimum ≈ 7.96 NEAR**; approval ceiling **9 NEAR**
- Approval JSON remains `"approved": false`

---

## 7. Remaining blockers

1. Operator Ledger mainnet account not created  
2. Explicit deploy approval (target + sha256 + max NEAR)  
3. Funded 1Click quote / deposit still gated — dry has no deposit address  
4. Policy not on-chain → no live `request_signature` / settlement proof  
5. `NIO_MAINNET_ALLOW_SIGN` / broadcast remain OFF (correct)  
6. 0x / NEAR DEX not wired (intentionally stubbed)  
7. Set non-zero `max_gas_budget` in init before funded EVM (0 currently means “no cap” in contract)

---

## 8. Confirmation

**No funded transactions or deployment occurred.** Broad autonomous trading is **not** operational; NIO now has a security-hardened sign path (unit-proven), one real production dry route, and an approval-ready Ledger deploy estimate.
