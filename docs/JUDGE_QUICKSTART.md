# Judge Quickstart — NIO (NEAR Intent One)

Read-only verification path. **You never need a private key, Ledger, funded wallet, or mainnet signer.**

**Deadline context:** NEAR HACKATHON development ends **2026-11-14 23:59 UTC**.

---

## Hosted demo (fastest)

| Surface | URL |
| --- | --- |
| Live product | https://near-intent-one.vercel.app |
| Public mainnet agent | https://near-intent-one.vercel.app/inspect/nishanthb.near |
| Mandate | https://near-intent-one.vercel.app/mandate |
| Proof & Verify | https://near-intent-one.vercel.app/verify |
| Security posture | https://near-intent-one.vercel.app/security |
| Policy contract | https://nearblocks.io/address/policy.nishanthb.near |
| Autonomous NO_TRADE receipt | https://nearblocks.io/txns/CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s |
| Full proof index | [PROOF_INDEX.md](./PROOF_INDEX.md) |

Default workspace is **Nishanth public mainnet** (`nishanth_public`). Wallet connect is optional for browsing.

---

## Requirements (local)

| Tool | Version tested |
| --- | --- |
| Node.js | ≥ 20 (tested **v22.13.0**) |
| pnpm | **10.15.0** (`packageManager` field) |
| Rust / cargo | for contract tests (tested **1.99.1**) |

---

## Install

```bash
git clone https://github.com/n1shanthb/near-intent-one.git
cd near-intent-one
pnpm install
```

No `.env` is required for frontend build, unit tests, or read-only mainnet views.

---

## Frontend (local)

```bash
pnpm --filter web run build   # production build (tsc + vite)
pnpm --filter web run dev     # http://localhost:5173
```

Open `/inspect/nishanthb.near` — public mode loads live mandate/decisions from the BFF → OCI read API.

---

## One-command safe verification

```bash
node scripts/judge-verify.mjs
# or
pnpm run judge:verify
```

Runs only: Node check, frontend build, autonomous + mandate unit tests, policy `cargo test`, live frontend HTTP, OCI/Vercel mandate reads.

**Does not:** sign, spend, deploy, unpause, change policy, or touch Ledger.

---

## Contract tests

```bash
cd contracts/policy
cargo test
```

Expected: **56 passed**.

---

## Autonomous / audit / commerce unit tests

```bash
pnpm run test:autonomous   # shadow agent, journal, simulate cycle
pnpm run test:mandate      # allowlist / asset id rules
pnpm run test:commerce     # budget isolation + live discovery (no pay)
pnpm run test:j16          # settlement integrity (simulator ≠ settled)
```

---

## Read-only mainnet verification

### Live mandate API (OCI)

```bash
curl -s https://nio-api-hack26.duckdns.org/mainnet/mandate | jq '{epoch:.mandate_epoch, trade:.limits.max_trade_value, daily:.limits.daily_turnover_limit, slippage:.limits.max_slippage_bps, paused, autonomous_trading, expiry}'
```

**Expected (as of 2026-11-14 after judge renew):**

- `mandate_epoch`: **4**
- `max_trade_value`: `"5000000"` ($5 USDC, 6 decimals)
- `daily_turnover_limit`: `"25000000"` ($25)
- `max_pending_exposure`: `"10000000"` ($10)
- `max_slippage_bps`: **200**
- `paused`: `false`
- `autonomous_trading`: `true`
- `enforce_autonomous_on_agent`: `true`
- expiry ≈ **2026-11-24 UTC** (~10 days from renew)

### Vercel BFF proxy

```bash
curl -s https://near-intent-one.vercel.app/api/v1/mainnet/mandate | jq .mandate_epoch
```

### On-chain views (any public RPC)

Query `policy.nishanthb.near`: `get_mandate_epoch`, `get_limits`, `get_paused`, `get_autonomous_trading`, `get_enforce_autonomous_on_agent`.

---

## How to inspect a NEAR receipt

1. Open https://nearblocks.io/txns/CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s
2. Confirm signer / receiver involve `policy.nishanthb.near` or agent flow
3. Expand logs for `EVENT_JSON` — expect `research_completed`, `strategy_proposed`, `fitter_evaluated`, `critic_evaluated`, `decision_finalized`
4. Cross-check evidence hash `0df66baea166fc76dfe958993330516efc2d060ec46330264203beb02e588f10` in [`docs/evidence/NO_TRADE_ONCHAIN_RECEIPT.json`](./evidence/NO_TRADE_ONCHAIN_RECEIPT.json)

For Intents settlements (J8B / M1 / M2), open the EVM explorer link **and** the NEAR reconcile tx from [PROOF_INDEX.md](./PROOF_INDEX.md).

---

## Expected outputs (summary)

| Check | Expected |
| --- | --- |
| `pnpm --filter web run build` | Vite build succeeds |
| `cargo test` (policy) | 56 passed |
| `pnpm run test:autonomous` | all pass |
| Hosted routes `/`, `/mandate`, `/verify`, `/inspect/nishanthb.near` | HTTP 200 |
| `/mainnet/mandate` | epoch ≥ 3, autonomous on, not paused |
| CXR4ey… receipt | `NO_TRADE` / fitter `REJECTED` / `NO_OPPORTUNITY` |

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| FastNear / RPC 429 | Retry; public API prefers `rpc.mainnet.near.org` with backoff |
| Mandate shows UNKNOWN | Cold cache — refresh; LAST_KNOWN_GOOD may show until LIVE |
| `pnpm` missing | `corepack enable` then `corepack prepare pnpm@10.15.0 --activate` |
| Cargo not found | Install Rust; only needed for contract tests |
| Commerce discovery flaky | Network to `market.near.ai`; tests skip payment |

---

## Intentionally NOT reproducible without owner credentials

| Operation | Why |
| --- | --- |
| `activate_autonomous_mandate` / `set_policy` / `unpause` / `revoke` | Owner Ledger FullAccess on `nishanthb.near` |
| Propose / MPC sign / EVM broadcast canaries | Owner-supervised or agent FunctionCall key + funded gas |
| Deploy / migrate WASM | Owner Ledger |
| Marketplace hire / escrow top-up | Separate commerce buyer session (not in repo) |
| OpenRouter live LLM keeper cycles | `OPENROUTER_API_KEY` on OCI — not required for judge inspection |

Judges should use **hosted demo + explorers + unit tests**. Do not request keys.
