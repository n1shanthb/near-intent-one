# Custody isolation — Gate I architecture

Testnet only. Does **not** modify Ledger-governed demo accounts (`nio-c-*`).

## How Chain Signatures derive custody

NEAR MPC (`v1.signer-prod.testnet`) produces a secp256k1 key from:

```text
path = "trading/v1/portfolio/" + portfolio_id
```

- `portfolio_id` is immutable after `PolicyContract::new`.
- Path is **stable across mandate epochs** (epoch is not in the path).
- Distinct `portfolio_id` ⇒ cryptographically distinct EVM address (Intents signer) and Sepolia deposit identity.
- Collision rule: factory rejects any `portfolio_id` already registered; IDs are `i-<userTag>-<8hex>` and must not contain `/`.

## Policy authorization isolation

| Concern | Isolation mechanism |
|---------|---------------------|
| Who may `set_policy` / `revoke` / withdraw | Per-contract `owner` AccountId only |
| Who may trade (`propose_*` / `request_signature`) | Per-contract `agent` AccountId only |
| Who may reconcile | Per-contract owner **or** pinned `reconciler` |
| Cross-user admin | Impossible: User B’s key is not `owner`/`agent` on User A’s contract |

## Upgrade authority isolation

Each portfolio is a **separate NEAR contract account** with its own WASM + storage.

| Account | FullAccess meaning |
|---------|-------------------|
| `…-policy-….testnet` | Can `DeployContract` (replace WASM) for **that** portfolio only |
| After onboarding | Owner’s key (wallet/Ledger) is FullAccess; provisioner key is deleted |

There is **no** shared software master key that can upgrade every user’s contract.

Demo Ledger portfolio (`nio-c-policy-857107.testnet`) stays Ledger-only and is never reused as Gate I onboarding.

## Architecture choice: **per-user policy contracts** (not multi-tenant shared contract)

**Chosen:** factory/provisioner creates one policy contract account per user.

**Rejected for Gate I:** single shared contract with internal user map — upgrade authority and storage DOS risk would couple all users; harder to prove “User B cannot touch User A.”

### Provisioning flow (testnet)

1. User connects wallet (software FullAccess or Ledger) as **owner**.
2. Provisioner (localhost/hosted, scoped credentials) creates:
   - optional owner named account (or uses connected wallet id)
   - policy subaccount / faucet account
3. Deploy `policy.wasm` → `new(owner, agent, mpc, portfolio_id, verifier, limits)`.
4. Bind `set_intents_signer_id` after off-chain derive of MPC EVM address for that path.
5. Add owner FullAccess on policy account; **delete** provisioner FullAccess.
6. Owner confirms `set_policy` (explicit wallet/Ledger approval).

### Shared hosted roles (not custody keys)

| Role | Scope |
|------|--------|
| Agent service | May call trade methods **only** on portfolios that registered it as `agent` |
| Attestor | Signs quote attestations; no NEAR FullAccess on user contracts |
| Reconciler | May `reconcile_pending` only where pinned; verifies receipts off-chain first |

These services never hold the MPC seed (MPC is NEAR network signer) and never hold user Ledger seeds.
