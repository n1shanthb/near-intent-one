# J17.3 — Exact owner authorization previews

**Engineering hard stop active.** These previews are not execution. Auth flags, secret files, and transaction previews alone are **not** successful execution — a fresh live preflight must pass immediately before any authorized transfer.

## A) Provision journal secret (local, once)

```powershell
npm run j17:provision-journal-secret
$env:NIO_TX_JOURNAL_SECRET_PATH = (Resolve-Path .nio-secure\j17\journal.secret)
```

Or set `NIO_TX_JOURNAL_SECRET` (≥32). Never print/commit/regenerate on crash recovery.

## B) Register trusted quote signer (testnet only — separate auth)

```powershell
$env:J17_QUOTE_SIGNER_REGISTER_AUTHORIZED = "1"
npm run j17:register-quote-signer
```

| Field | Value |
|-------|-------|
| network | testnet |
| contract | `j16f6890.testnet` |
| actor | `nio-owner-02b7cf.testnet` |
| method | `set_trusted_quote_signer` |
| args | `{ "public_key": "ed25519:FpYz8GbzcFDmmHcFVffnVSJfroguqZVudNU6yt6Wuozh" }` |
| verify | `is_trusted_quote_signer` → true |
| not from | broadcast / MPC scripts |

## C) MPC sign + one Sepolia ERC-20 transfer (separate auth)

Prereqs: (A) secret configured, (B) signer registered, live `npm run j17:presign-check` all engineering + journal gates PASS.

```powershell
$env:J17_MPC_SIGN_BROADCAST_AUTHORIZED = "1"
npm run j17:mpc-broadcast
```

Envelope: chain `11155111`, token `0x2e6AD9…DAD2`, to `0x70997970…79c8`, amount ≤ `1000000`, exactly one attempt. Intent locked **before** propose; ambiguous NEAR ⇒ quarantine, no new `operation_id`.

`J17_SEPOLIA_FUNDING_AUTHORIZED` alone does **not** unlock this path.

## D) Post-test revoke (separate auth)

```powershell
$env:J17_QUOTE_SIGNER_REVOKE_AUTHORIZED = "1"
npm run j17:revoke-quote-signer
```

| Field | Value |
|-------|-------|
| method | `remove_trusted_quote_signer` |
| args | `{ "public_key": "ed25519:FpYz8GbzcFDmmHcFVffnVSJfroguqZVudNU6yt6Wuozh" }` |
| verify | `is_trusted_quote_signer` → false |

## HARD STOP (this engineering run)

No A/B/C/D mutations were executed with authorization enabled.
