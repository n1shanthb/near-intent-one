# Ledger-controlled mainnet policy deploy (approval-ready)

**Status:** Estimate + ceremony design — **no account created, no funds spent, no deploy, no signing**  
**Date:** 2026-11-11  
**Network:** NEAR mainnet  
**Funded gates:** ALL OFF (`NIO_MAINNET_ALLOW_SIGN` / `ALLOW_BROADCAST` / `ALLOW_FUNDED_QUOTE` / `FUNDED_UNLOCK` unset)

## Artifact (deploy this hash only)

| Field | Value |
|-------|-------|
| Path | `artifacts/mainnet/policy.wasm` |
| Bytes | **625701** |
| SHA-256 | **`3bc7c1120a1f593a4c96ff58171ce9521f780ceec0427d97f90f0cac9ecc4f90`** |
| Init | `paused=true`, `revoked=false` (inert until owner `unpause`) |
| Supersedes | `f8e51e44…565fb0` and all earlier hashes |

## Two permission planes (do not conflate)

| Plane | What it controls |
|-------|------------------|
| **Policy-account FullAccess key** | Who can `DeployContract`, `AddKey`/`DeleteKey`, transfer NEAR on `policy.<owner>.near` |
| **Contract `owner` role** (`new(owner=…)`) | Who can `unpause` / `pause` / `revoke` / `set_policy` / withdraw — checked inside WASM |

Parent `<owner>.near` FullAccess does **not** let you deploy code onto `policy.<owner>.near` unless that child account’s own access-key set authorizes the signer. After `CreateAccount`, the child’s keys must explicitly include the Ledger (or temporary deploy) FullAccess used for `DeployContract`.

## Key topology (target end-state)

```
<owner>.near          FullAccess = Ledger pk_L only
policy.<owner>.near   FullAccess = Ledger pk_L only  (same device path or dedicated path)
agent.<owner>.near    keys OFFLINE until funded canary (not on OCI/Vercel)
```

Contract init: `owner=<owner>.near`, `agent=agent.<owner>.near`, `mpc_signer=v1.signer`.

## Ledger / near-cli-rs support (verified from public docs — not executed here)

| Step | Ledger `sign-with-ledger` | Notes |
|------|---------------------------|-------|
| Create named account / AddKey / DeleteKey / small `FunctionCall` | **Supported** by near-cli-rs | Requires Ledger + NEAR app open; CLI not installed on this workstation today |
| `DeployContract` (~625701 B WASM) | **Not operational on stock NEAR Ledger app** | Device tx buffer overflow (`0x6990` / APDU 27024); known near-cli-rs / app-near limitation |

**Therefore the naïve sequence “Ledger signs DeployContract” is NOT operational.** Use the rotate ceremony below.

## Operational ceremony (human Ledger confirms each marked step)

### A. Parent bootstrap
1. Create `<owner>.near` with Ledger FullAccess (MyNearWallet / near-cli-rs `use-ledger`).
2. Fund parent ≥ **9 Ⓝ**.

### B. Child account + temporary deploy key (required for WASM size)
3. From parent: `CreateAccount` + fund `policy.<owner>.near` + `AddKey` **temporary software FullAccess** `pk_tmp` on the **policy** account (or create child with `pk_tmp` as its initial FullAccess).
4. **Human confirms** parent-signed create/add-key txs on Ledger.

### C. Deploy + init (software signs large tx only)
5. Using `pk_tmp` as signer for `policy.<owner>.near`: `DeployContract` with WASM matching SHA-256 above.
6. Using `pk_tmp` **or** Ledger (init args are small): call `new(...)` → contract starts **`paused=true`**.
7. **Do not** call `unpause`.

### D. Rotate to sole Ledger FullAccess on policy account
8. From `pk_tmp` (or parent if still authorized): `AddKey` Ledger `pk_L` as **FullAccess** on `policy.<owner>.near`.
9. `DeleteKey` `pk_tmp` (and any other non-Ledger FullAccess).
10. **Human confirms** AddKey/DeleteKey on whichever signer remains; destroy `pk_tmp` material.

### E. Read-only verification (no spend)
```bash
# Replace ACCOUNT=policy.<owner>.near
curl -s https://rpc.mainnet.near.org -H 'content-type: application/json' -d "{
  \"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"query\",
  \"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"ACCOUNT\"}
}"

curl -s https://rpc.mainnet.near.org -H 'content-type: application/json' -d "{
  \"jsonrpc\":\"2.0\",\"id\":\"2\",\"method\":\"query\",
  \"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",
    \"account_id\":\"ACCOUNT\",\"method_name\":\"get_paused\",\"args_base64\":\"e30=\"}
}"
# Expect paused == true (borsh/json bool)

# Also call get_owner, get_agent, get_mpc_signer — expect v1.signer
```
Pass criteria: **only** Ledger `pk_L` FullAccess on policy account; `get_paused=true`; `get_mpc_signer=v1.signer`.

## Storage / max expenditure

| Line | Ⓝ |
|------|---|
| WASM storage | **6.25701** |
| Create / keys / gas / state buffers | ~0.70 |
| Operating headroom | ~1.00 |
| **Recommended minimum** | **≈ 7.96** |
| **Approval ceiling** | **9** |

## Rollback / recovery

| Situation | Action |
|-----------|--------|
| Deploy failed before `new` | Re-`DeployContract` with correct WASM; account still controlled by current FullAccess |
| Wrong WASM / bad init | If `new` not yet called, redeploy; if initialized, **no `upgrade` method** — freeze via Ledger `pause`/`revoke`, recover via owner withdraw paths, consider new subaccount |
| `pk_tmp` still present | **Abort go-live** until DeleteKey proven via `view_access_key_list` |
| Compromised agent key | Irrelevant while paused; still keep offline; owner may `revoke` |
| Need to abandon | Owner `revoke`; leave paused; do not `unpause` |

## Explicit non-actions

- No funded transfers / 1Click deposits  
- No `unpause` until separate trading-readiness approval  
- No enabling `NIO_MAINNET_ALLOW_*`  
- No autonomous trading  
