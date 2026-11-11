# Mainnet deployment preflight (approval checkpoint)

**Date:** 2026-11-11  
**Broadcast:** NOT performed  
**`approved`:** remains `false` — operator must set explicitly  

---

## TASK 1 — Deployment account (BLOCKING)

### Proposed name

| Account | Mainnet RPC result |
|---------|-------------------|
| `nio-policy-hack26.near` | **UNKNOWN_ACCOUNT** (does not exist) |
| `nio-policy-hack26` | does not exist |
| `hack26.near` | does not exist |

A top-level `*.near` name **cannot** be created by an ordinary key alone. It requires either:

1. **Registrar / marketplace purchase** of `nio-policy-hack26.near`, or  
2. **Subaccount** under an operator-controlled parent, e.g. `policy.<YOUR_ROOT>.near`, or  
3. **Implicit account** (64-hex) funded by a transfer.

### Credentials on this machine

| Path | Status |
|------|--------|
| `.near-credentials/testnet/` | Present (testnet only — **do not reuse**) |
| `.near-credentials/mainnet/` | **MISSING** |

**No authorized mainnet deployer, owner, or agent account is available in-repo.**  
These must be supplied by the operator. They will **not** be invented.

### Required operator identities (fill before approval)

| Role | Requirement | Status |
|------|-------------|--------|
| **Deployer** | Mainnet account + FullAccess key that can create/deploy the target | **UNKNOWN — provide** |
| **Owner** | Future Ledger-held FullAccess on mainnet (policy `owner`) | **UNKNOWN — provide** |
| **Agent** | Separate mainnet account; key **offline** until canary | **UNKNOWN — provide** |
| **Target** | Existing account **or** creatable subaccount / purchased name | `nio-policy-hack26.near` unavailable as-is |

**Recommended deployable pattern:**  
`policy.<operator_root>.near` created by `<operator_root>.near`, with `owner=<ledger_account>.near`, `agent=<agent>.near`.

---

## TASK 2 — Exact costs (estimate vs cap)

### Frozen artifact (post clean rebuild)

| Field | Value |
|-------|-------|
| Path | `artifacts/mainnet/policy.wasm` |
| Bytes | **617768** |
| SHA-256 | **`be60e78933d941aed7d1a4b9b0f7f7ad7756b0b867c29c6f0b2eed3d0eab9f1a`** |

> Prior documented hash `8b6ba726…3022` (612184 B) is **superseded**. A clean rebuild is not bit-identical across toolchains/paths; approve **this frozen file** only.

### Cost model (mainnet protocol)

| Component | Estimate | Notes |
|-----------|----------|-------|
| Account creation charge | **~0.007 Ⓝ** | If CreateAccount needed |
| Add access key | **~0.00005 Ⓝ** | Gas |
| Deploy gas | **~0.01 Ⓝ** | Rough; refunds apply |
| **Code storage stake** | **~6.178 Ⓝ** | 617768 B × 1e−5 Ⓝ/B |
| Init (`new`) gas + state | **~0.02–0.10 Ⓝ** | Maps + args; keep headroom |
| **Estimated actual total** | **≈ 6.25 – 6.40 Ⓝ** | Dominated by storage |
| **Recommended max cap** | **8 Ⓝ** | Not 15 |
| Previous default 15 Ⓝ | Rejected as overspend | Use 8 unless create-account path is exotic |

Funds locked in storage remain on the contract account as balance reserved for code.

---

## TASK 3 — Security gate

| Check | Result |
|-------|--------|
| Frozen WASM ↔ this rebuild | **PASS** (hash above) |
| Unit tests | **18/18** previously; re-run before broadcast |
| `mpc_signer` must be | `v1.signer` |
| No contract `upgrade` method | **PASS** (code change = redeploy by account controller) |
| Acceptance override | **FORBIDDEN** in mainnet safety path |
| Public demo / OCI | `NEAR_NETWORK` hard-requires **testnet** |
| Funded trading flags | All `NIO_MAINNET_ALLOW_*=0` |
| Testnet creds on mainnet | **Banned** |
| Demo `nio-c-*` | **Banned** |

### On-chain agent can still call `request_signature`

**Yes.** `GATE_K_ALLOW_SIGN` / `NIO_MAINNET_ALLOW_SIGN` are **off-chain only**.  
If the agent account’s private key is online, it can call `propose_*` + `request_signature` on a live mandate regardless of those env flags.

**Mitigations before any mainnet agent key is hot:**

1. Init with **empty `allowed_assets` / zero `max_trade_value`** (or call `pause()` immediately after init).  
2. Keep **agent private key offline** (not on OCI, not in Vercel).  
3. Owner Ledger retains `revoke` / `pause`.  
4. Do not enable off-chain Gate K mainnet execute routes on the public BFF.

---

## TASK 4 — 1Click dry quote

| Probe | Result |
|-------|--------|
| Independent registry fetch | **229 tokens** verified (`docs/MAINNET_1CLICK_TOKENS_SAMPLE.json`) |
| This Windows host → API | **HTTP 403 HTML** (WAF / edge interstitial), not JSON `401` |
| TLS on host | Also `UNABLE_TO_VERIFY_LEAF_SIGNATURE` without insecure workaround |
| Fake Bearer token | Still **403 HTML** → not “missing JWT” as the first failure mode |
| `dry=true` quote from this environment | **NOT OBTAINED** |

**Conclusion:** Blocker is **edge/WAF + local TLS trust**, not payload inventiveness. Official Partner JWT may still be required for reliable server-side access; obtain via Partner Dashboard / keys docs (do **not** put JWT in browser or git).

Unauthenticated quotes (higher fee) remain **NOT YET PROVEN** from this workspace.

---

## TASK 5 — Approval summary (ready for you to sign)

| Field | Value |
|-------|-------|
| Exact target account | **UNRESOLVED** — `nio-policy-hack26.near` not creatable without registrar/parent |
| Deployer account | **PROVIDE** |
| Owner account | **PROVIDE** (Ledger mainnet) |
| Agent account | **PROVIDE** (key cold) |
| Portfolio ID | Proposed `hack26-canary` (confirm) |
| Exact WASM SHA-256 | `be60e78933d941aed7d1a4b9b0f7f7ad7756b0b867c29c6f0b2eed3d0eab9f1a` |
| Estimated NEAR | **≈ 6.3 Ⓝ** |
| Recommended max cap | **8 Ⓝ** |
| MPC | `v1.signer` |
| Derivation path | `trading/v1/portfolio/<portfolio_id>` |
| Funded trading | **OFF** |
| Rollback | Owner `pause`/`revoke`; no upgrade backdoor; redeploy only with account keys |

### Rollback / remediation

1. Owner calls `pause` then `revoke`.  
2. If compromised agent key: revoke immediately; rotate agent off-chain.  
3. Contract account remains; code swap only if deployer keys allow redeploy.  
4. Public demo unaffected (separate testnet host).

### Single operator action required

Provide **one** of:

**A.** Parent account + create subaccount plan:  
`Deployer=<root>.near` → target `policy.<root>.near`, plus owner/agent IDs and confirm max **8 Ⓝ**.

**B.** Proof you control / purchased `nio-policy-hack26.near`, plus deployer/owner/agent and max **8 Ⓝ**.

Then set those fields in `docs/approvals/MAINNET_DEPLOY_APPROVAL.json` and set `approved: true` yourself.  
Only after that will broadcast be attempted.

**Funded trading stays disabled.**
