# Mainnet deployment readiness

**Status:** IMPLEMENTED tooling — **NOT DEPLOYED** (awaiting your explicit approval)  
**Date:** 2026-11-11  
**Network:** NEAR mainnet  
**MPC signer:** `v1.signer` (official; distinct from testnet `v1.signer-prod.testnet`)

## Isolation rules

| Concern | Testnet (unchanged) | Mainnet |
|---------|---------------------|---------|
| Env | `NEAR_NETWORK=testnet` (OCI / public demo) | `NIO_NETWORK=mainnet` + `NIO_MAINNET_MODE=1` |
| Credentials | `.near-credentials/testnet/` | `.near-credentials/mainnet/` |
| MPC | `v1.signer-prod.testnet` | `v1.signer` |
| Settlement | Tidepool sandbox | Production 1Click (`https://1click.chaindefuser.com`) |
| EVM | Sepolia | Production chain (default Arbitrum config; confirm before fund) |
| Signing | `GATE_K_ALLOW_SIGN=0` | `NIO_MAINNET_ALLOW_SIGN=0` (default) |
| Demo | `nio-c-*` allowed for judges | **Banned** on mainnet paths |

Public OCI API **refuses** `NEAR_NETWORK≠testnet` — judge demo stays testnet-only.

## Policy contract audit (summary)

Source: `contracts/policy/`

| Check | Result |
|-------|--------|
| Owner init | `new(owner, agent, mpc_signer, portfolio_id, verifying_contract, limits)` once |
| Access control | Owner: set_policy / pause / revoke / withdraw; Agent: propose / request_signature |
| Assets / amounts | Enforced via `PolicyLimits` + pending exposure |
| Revocation | `revoke` increments epoch; blocks propose/sign; cancel/withdraw paths owner-only |
| Replay / epoch | Pending ops bind mandate epoch; callback blocked after revoke |
| Upgrade | No open `upgrade` method in contract — code upgrade = redeploy/account control |
| MPC | `mpc_signer` stored at init; mainnet must be `v1.signer` |
| Events | `EVENT_JSON` logs for policy/revoke/sign/withdraw |
| Unit tests | **28/28 PASS** (`cargo test` in `contracts/policy`) |

WASM artifact path (deploy this hash only after approval):

`artifacts/mainnet/policy.wasm`  
SHA-256 `aa301524d9cfa99cbf0948d8e65f5f137411d494da91805770314fc6801b0202` (625565 B)

**Frozen artifact:** `artifacts/mainnet/policy.wasm`  
**SHA-256:** `6fd1912f5912f52481f788ee0a4f7fec1cbc3cafd34496d53e61feb59c1a30d1` · 624900 bytes  
**Includes:** `token_scope`, `allowed_chains`, `allowed_venues`, `max_gas_budget` (open-universe mandate)  
**STOP:** Do not deploy older hashes (`8b6ba726…` / `be60e789…`)  
**Proposed account:** `nio-policy-hack26.near` — **does not exist**; needs registrar or parent subaccount  
**Approval stub:** `docs/approvals/MAINNET_DEPLOY_APPROVAL.json` (`approved: false`)  
**Recommended max NEAR:** **8** (estimate ≈ 6.4; do not use 15)  
**Vision:** `docs/OPEN_UNIVERSE_ARCHITECTURE.md`

Rebuild:

```bash
cargo build --release --target wasm32-unknown-unknown --manifest-path contracts/policy/Cargo.toml
```

## What you must approve before deploy

Create/edit `docs/approvals/MAINNET_DEPLOY_APPROVAL.json` with:

- `approved: true`
- `target_account` — dedicated mainnet account (e.g. `nio-policy-hack26.near`)
- `wasm_sha256` — must match readiness snapshot
- `max_near` — hard cap (hint: 8–15 NEAR)
- `owner_account` / `agent_account` / `portfolio_id`
- `mpc_signer: "v1.signer"`
- `approver` + `approved_at`

Then:

```bash
node scripts/mainnet/readiness.mjs
node scripts/mainnet/deploy-policy.mjs --account <ACCOUNT.near> --sha256 <HEX> --max-near <N> --approve-file docs/approvals/MAINNET_DEPLOY_APPROVAL.json
```

Add `--execute` only after the plan prints `APPROVED_AWAITING_EXECUTE`.  
Broadcast remains intentionally blocked until deployer credentials are separately committed.

## Gas / storage estimate

| Item | Hint |
|------|------|
| Recommended min | ~8 NEAR |
| Requested max (default) | 15 NEAR |
| Deploy vs create-account | Create-account + deploy costs more than upgrade-only |

Exact cost depends on whether the named account already exists.

## Distinction

| Claim | Meaning |
|-------|---------|
| Contract DEPLOYED | Init tx confirmed on mainnet RPC + explorer |
| Ledger-owned mandate | Owner FullAccess is physical Ledger; NEP-413 session proven |
| FUNDED EXECUTION PROVEN | Signed + broadcast + settled with receipts |

A deployed contract **without** Ledger ownership is still **not** a production mandate.
