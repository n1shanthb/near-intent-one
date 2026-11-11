# Owner authentication API (Chat 2 contract)

**Network:** testnet only  
**Scheme:** **NEP-413** (wallet-selector `signMessage` / Ledger-compatible message signing)  
**Purpose:** Prove NEAR account ownership without treating `claimed_owner` or `GATE_I_API_KEY` as user auth.

Public judge demo stays independent — **do not** allowlist these routes on the public Vercel BFF.

## Compatibility (Ledger / wallets)

| Client | How to sign |
|--------|-------------|
| MyNearWallet / Meteor / wallet-selector | `signMessage({ message, recipient, nonce, callbackUrl? })` → NEP-413 |
| Ledger via wallet-selector ledger module | Same NEP-413 `signMessage` when supported |
| Raw Ledger WebHID tx-only (`SIGN_TRANSACTION`) | **Not sufficient** for session auth — must sign NEP-413 payload hash |

**Verifier:** SHA-256( borsh(u32 `2147484061`) ‖ borsh(Payload) ) then ed25519 verify.  
**Key requirement:** signing key must be **FullAccess** on `account_id` (live RPC check).  
**Bindings preserved:** domain(=recipient), account (in message + verify body), network=testnet, 32-byte nonce, expiry, single-use challenge (replay rejected).

## Endpoints (OCI `/v1`)

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/v1/owner/challenge` | none |
| `POST` | `/v1/owner/verify` | none |
| `GET` | `/v1/owner/session` | `X-NIO-Owner-Session` |
| `POST` | `/v1/owner/logout` | `X-NIO-Owner-Session` |
| `GET` | `/v1/owner/portfolios` | `X-NIO-Owner-Session` (own rows only) |
| `GET` | `/v1/portfolios/mine` | same as `/owner/portfolios` |
| `GET` | `/v1/owner/provision-requests` | `X-NIO-Owner-Session` (own requests) |
| `POST` | `/v1/portfolios` `action=lookup\|status` | session → `ready` / `awaiting_provision` / `no_portfolio` |

Personal `GET /v1/portfolios/:id`, balances, and deposits require a matching owner session (demo `nio-c-*` / first-test `i-a-a4e7` stay publicly readable for the judge BFF).

### Challenge

```http
POST /v1/owner/challenge
{ "account_id": "alice.testnet", "domain": "near-intent-one.vercel.app" }
```

Response includes:

```json
{
  "ok": true,
  "challenge": {
    "scheme": "nep413",
    "challenge_id": "…",
    "account_id": "alice.testnet",
    "recipient": "near-intent-one.vercel.app",
    "domain": "near-intent-one.vercel.app",
    "network": "testnet",
    "nonce": "<base64 32 bytes>",
    "nonce_encoding": "base64",
    "message": "NIO owner authentication\n…",
    "wallet_sign_message": {
      "message": "…",
      "recipient": "near-intent-one.vercel.app",
      "nonce": "<base64>"
    },
    "issued_at": "…",
    "expires_at": "…"
  }
}
```

Decode `nonce` to `Uint8Array(32)` for wallet-selector.

### Verify

```http
POST /v1/owner/verify
{
  "challenge_id": "…",
  "account_id": "alice.testnet",
  "domain": "near-intent-one.vercel.app",
  "public_key": "ed25519:…",
  "signature": "<base64 NEP-413 signature>"
}
```

Returns `session.token` → send as `X-NIO-Owner-Session` on owner actions.

### Failure reasons

`challenge_expired` · `challenge_replay` · `account_mismatch` · `domain_mismatch` · `wrong_network` · `bad_signature` · `public_key_not_on_account` · `full_access_key_required`

## Owner-gated routes

| Route | Rule |
|-------|------|
| `POST /v1/portfolios` | Owner session; `action=register\|request_provision\|create` |
| `POST /v1/portfolios/:id/withdrawals/quote` | Session = portfolio owner |
| `POST /v1/portfolios/:id/withdrawals` | Prepare Ledger call **or** attach `near_tx_hash` |
| `GET /v1/portfolios/:id/withdrawals/:wid` | Session = owner |
| `POST /v1/gate-k/decide` (`AI_TESTNET_EXECUTION`) | API key **and** owner session matching portfolio owner; **no acceptance_override** |

## Portfolio actions

```json
{ "action": "register", "owner_account": "alice.testnet", "policy_contract": "….testnet" }
```

On-chain `get_owner` must equal session account. Demo `nio-c-*` rejected.

```json
{ "action": "request_provision", "owner_account": "alice.testnet" }
```

Creates isolated `portfolio_id` + awaiting_operator (or queued_self if `GATE_I_SELF_PROVISION=1`).

## Withdrawal

1. `POST …/withdrawals` with `{ destination, amount }` → `AWAITING_OWNER_SIGNATURE` + `near_function_call` template.  
2. Owner Ledger/wallet signs `owner_request_withdraw_signature`.  
3. `POST …/withdrawals` with `{ withdraw_id, near_tx_hash }` → `OWNER_SUBMITTED`.  
4. Disclose: **exported EVM ECDSA cannot be recalled by NEAR mandate revoke.**

## Chat 2 checklist

1. Challenge with `window.location.hostname` as domain.  
2. `signMessage` NEP-413 (not raw UTF-8, not tx-only).  
3. Verify → store session (not on public demo BFF).  
4. Attach `X-NIO-Owner-Session` for personal portfolio / withdraw / Gate K execution.  
5. Keep `/api/v1/gate-j/demo-decide` unchanged for judges.
