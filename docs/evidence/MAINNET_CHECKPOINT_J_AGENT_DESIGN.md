# Checkpoint J — Agent account & signing model (PREP ONLY)

**Broadcast / mainnet mutations:** NONE  
**Policy remains:** `paused=true`, `autonomous_trading=false`, funded trading OFF

## Live preflight

| Check | Result |
|-------|--------|
| `agent.nishanthb.near` | **Does not exist** |
| `nishanthb.near` available | ≈ **3.24 NEAR** |
| Owner Ledger FA | `ed25519:7AMsxZH3HdjRj9twcR2aXyVUdYJZNzgy6ZeRajwkBx58` |
| HD path | `m/44'/397'/0'/0'/1'` |
| Contract agent field | `agent.nishanthb.near` (reserved identity) |

## 1-yocto requirement (contract fact)

`request_signature` is `#[payable]` and requires:

```text
env::attached_deposit() >= 1 yoctoNEAR
```

It then forwards **1 yoctoNEAR** to `v1.signer` `sign()`.  
`propose_quoted_evm_transfer` does **not** require deposit.  
NEAR protocol: **FunctionCall-limited access keys cannot attach deposit > 0**.

Therefore a FunctionCall-only agent key can propose but **cannot** complete MPC `request_signature`.

## Option comparison

| | **A — Agent account + software FullAccess (ops) + Ledger FA (recovery)** | **B — Relay contract on agent.nishanthb.near + FC ops key** |
|--|--|--|
| 1-yocto | Software FA attaches 1 yocto natively | Relay contract attaches 1 yocto in XCC; FC key calls relay only |
| `predecessor == agent` | Yes | Yes (XCC predecessor = agent account) |
| Effort | Low — matches current testnet agents | High — new WASM, audit, deploy, storage |
| Blast radius if ops key stolen | Drain **agent** NEAR only; call agent methods when unpaused; **cannot** touch owner/policy keys | Smaller method surface if relay is minimal |
| Ops key on owner/policy | **Forbidden** | **Forbidden** |
| Compatibility with deployed policy | Full | Full (after relay built) |
| Ready before mainnet agent activation | Yes | No (blocked on new code) |

**Recommendation: Option A** for the next mainnet step.  
It is the only design that is compatible with the **already-deployed** policy and supports real unattended `request_signature` without shipping an unaudited relay. Option B remains the longer-term least-privilege upgrade after a dedicated relay is tested.

Testnet precedent: `nio-i-a4e7-agent.testnet` already uses **software FullAccess** on the agent account only.

## 1-yocto compatibility proof

1. Contract source: `request_signature` rejects `attached_deposit < 1` and attaches `ONE_YOCTO` to MPC.  
2. Unit test `revoke_blocks_request_signature` exercises `request_signature` with **deposit = 1** from agent context.  
3. Protocol rule: FC keys cannot attach deposits → FC-only agent model **fails** at MPC step.  
4. Option A software FA on `agent.nishanthb.near` **can** attach 1 yocto; Ledger FA remains for recovery/`DeleteKey` only.

## Isolation guarantees (Option A)

| Credential | Can do | Cannot do |
|------------|--------|-----------|
| Agent software FA | Sign txs as `agent.nishanthb.near` (propose / request_signature when allowed) | Sign as `nishanthb.near` or `policy.nishanthb.near`; redeploy policy; move owner funds |
| Owner Ledger FA | Create agent, AddKey/DeleteKey on agent, owner policy methods | Not used for unattended trading |
| Policy Ledger FA | Policy account only | Not an agent key |

## Funding (not moved yet)

| Item | Amount |
|------|--------|
| Create `agent.nishanthb.near` initial balance | **0.5 NEAR** |
| Rationale | Gas + many 1-yocto MPC attaches; keep balance small and explicit |
| Owner remaining after (approx) | ≈ 2.74 NEAR |

## Key lifecycle (after account exists — later checkpoints)

1. Ledger creates child with **Ledger FA only**.  
2. Owner Ledger `AddKey` software FA on **agent only**; store key under `~.nio-secure/` (never git/chat).  
3. Keep trading paused until attestor + funding approvals.  
4. Compromise response: Ledger `DeleteKey` software FA; optional `revoke` on policy; rotate new ops key.

## First Ledger command (create account only — DO NOT SEND until approved)

```powershell
$near = "$env:USERPROFILE\bin\near-cli-rs\near-cli-rs-x86_64-pc-windows-msvc\near.exe"
$HD = "m/44'/397'/0'/0'/1'"
$LEDGER_PK = "ed25519:7AMsxZH3HdjRj9twcR2aXyVUdYJZNzgy6ZeRajwkBx58"

# Unsigned preview
& $near account create-account fund-myself agent.nishanthb.near '0.5 NEAR' `
  use-manually-provided-public-key $LEDGER_PK `
  sign-as nishanthb.near network-config mainnet sign-later display

# When approved — Ledger sign (stop before send if preferred)
& $near account create-account fund-myself agent.nishanthb.near '0.5 NEAR' `
  use-manually-provided-public-key $LEDGER_PK `
  sign-as nishanthb.near `
  network-config mainnet `
  sign-with-ledger --seed-phrase-hd-path $HD `
  usb
```

**Expected unsigned tx:** signer `nishanthb.near` → receiver `agent.nishanthb.near` · `CreateAccount` + `Transfer 0.5 NEAR` + `AddKey` FullAccess Ledger pk only (no software key in this step).

## Readiness

**PASS** for Option A account-creation prep.  
**BLOCKED** for agent trading activation until: account exists, software ops key added & secured, trusted quote signer configured, EVM funded under separate approval, and explicit unpause — none of which are in this checkpoint.
