# J13 — Key Isolation Design (READ-ONLY audit → migration plan)

**Hard stop:** No mainnet access-key changes in this milestone.

## Live classification (mainnet, public keys only)

| Public key | Role | Present on |
|------------|------|------------|
| `ed25519:7AMsxZH3HdjRj9twcR2aXyVUdYJZNzgy6ZeRajwkBx58` | **Ledger** HD `m/44'/397'/0'/0'/1'` administrative FullAccess | `nishanthb.near`, `agent.nishanthb.near`, `policy.nishanthb.near` |
| `ed25519:DZUECSrU7kcqzN1PcSBGRgqf6uegsbTFxQ8wbDBxEbgJ` | **Software ops** FullAccess (MPC operator) | `agent.nishanthb.near` **only** |

Sources: Checkpoint J agent design, `packages/mainnet/identities.mjs`, `~/.nio-secure/mainnet-agent-ops/J2_PREP_META.json` (public metadata).

### Answers

1. **Ledger vs software:** `7AMs…` = Ledger; `DZUE…` = software ops.
2. **MPC operator key:** Software ops `DZUE…` on agent — attaches 1 yocto for `request_signature`.
3. **Policy admin / emergency:** Ledger `7AMs…` on policy + owner — `set_policy`, pause/revoke, deploy, AddKey/DeleteKey.
4. **Can agent operate without owner credentials?** **Yes**, for agent-scoped txs: ops key is not on owner/policy. Agent **cannot** sign as owner or mutate policy **unless** someone uses the Ledger key (human). Shared Ledger FA is recovery/admin, not a software-exported secret.

### Residual risk

Having the **same Ledger FA pubkey** on owner+agent+policy is intentional for recovery (Option A), but means one compromised Ledger session can administer all three. It is **not** the same as sharing the software ops private key. J12 `FAIL` correctly flagged the shared FA pubkey; J13 reclassifies: **software isolation is already correct; Ledger FA should remain owner/policy (and optionally agent recovery) only.**

## Target end-state

| Account | Keys |
|---------|------|
| Owner | Ledger FA only |
| Policy | Ledger FA only (upgrade + emergency) |
| Agent | Software ops FA (trading/MPC) + optional Ledger FA recovery |

**Never:** put ops software key on owner or policy.  
**Never:** DeleteKey the last FullAccess on any account.

## Safe migration sequence (mainnet — OWNER APPROVAL ONLY)

1. Confirm ops key present and usable on agent (view_access_key).
2. Confirm Ledger can still sign owner and policy (offline rehearsal).
3. Optional: if agent Ledger FA is undesired for blast-radius docs, keep it for recovery until a second recovery key exists — **do not delete** until two independent recovery paths exist on agent.
4. Do **not** remove Ledger from owner or policy.
5. Document rollback: re-AddKey Ledger FA if ever removed from agent after dual-recovery proven.

## Testnet rehearsal (this milestone)

Create disposable accounts with **three distinct software keys** simulating owner/ledger-admin, policy-admin, and agent-ops. Prove:

- Agent key cannot call `activate_autonomous_mandate` / `set_policy` / `pause` / `revoke` / `DeployContract` on policy.
- Owner key activates mandate once; agent key proposes multiple ops.
- Over-limit rejected; revoke blocks; agent attaches 1 yocto for `request_signature`.
