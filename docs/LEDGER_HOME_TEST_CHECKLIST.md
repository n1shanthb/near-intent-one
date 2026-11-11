# Ledger home test checklist (NEP-413 owner auth)

**When:** You have the physical Ledger Nano + NEAR app **≥ 2.1**  
**Goal:** Prove ownership → owner session → My Portfolio (no funded trade)  
**Backend:** `https://nio-api-hack26.duckdns.org/v1`  
**Frontend:** `https://near-intent-one.vercel.app/owner`  

Mocks/unit tests are **not** a substitute for this checklist.

---

## Before you start

1. Unlock Ledger; open **NEAR** app until its home screen (not Ledger dashboard).
2. Confirm NEAR app version ≥ **2.1** (needs `SIGN_NEP413_MESSAGE` / INS `0x07`).
3. Use Chrome or Edge on desktop (WebHID).
4. Close Ledger Live and other tabs claiming the device.
5. Know the **testnet** account id that already has this Ledger key as **FullAccess**.
6. Quick API ping (optional): open `https://nio-api-hack26.duckdns.org/v1/health` → `"ok":true`.

---

## Steps

| # | Action | Expected |
|---|--------|----------|
| 1 | Open https://near-intent-one.vercel.app/owner | Owner auth page loads |
| 2 | Click **Connect Ledger** → approve browser HID | Device connects; public key shown |
| 3 | Select/enter NEAR **testnet** account holding that FullAccess key | Account matches key on-chain |
| 4 | Click **Verify ownership** | Challenge issued (`scheme: nep413`) |
| 5 | **Approve the NEP-413 message on Ledger** (message sign — **not** a transfer) | Device returns signature |
| 6 | Wait for verify success | Session established; UI shows authenticated |
| 7 | Open **My Portfolio** | `ready` **or** `awaiting_provision` / `no_portfolio` (honest empty state) |
| 8 | Logout | Session cleared; portfolio personal controls locked |

---

## Expected API outcomes (if debugging)

- `POST /v1/owner/challenge` → `scheme: "nep413"`, `recipient` = site hostname, `nonce` base64 32 bytes  
- `POST /v1/owner/verify` → `session.token` / cookie set by owner gateway  
- Wrong account / FunctionCall-only key → `public_key_not_on_account` or `full_access_key_required`  
- Approve then retry same challenge → `challenge_replay`  
- `GET /v1/owner/portfolios` with session → only **your** portfolios  

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|----------------|-----|
| `0x6e01` / CLA not supported | Dashboard or wrong app | Open NEAR app home, reconnect |
| `0x6d00` / app not open | NEAR app closed | Open NEAR app ≥2.1 |
| `full_access_key_required` | Key is FunctionCall-only | Add Ledger FullAccess (wizard) first |
| `public_key_not_on_account` | Account ≠ key | Pick the account that holds this Ledger key |
| `domain_mismatch` | Hostname ≠ challenge domain | Use production URL, not a random preview host, or re-challenge |
| `challenge_expired` | Waited > ~5 min | Start verify again |
| `upstream_unreachable` / timeout | OCI host down | Check `/v1/health`; wait for recovery / Chat 1 |
| Session works but empty portfolio | Not provisioned | Expected until `register` / operator provision — **not** a Ledger failure |
| Device asks to sign a **transaction** | Wrong code path | Must be NEP-413 message (INS 0x07), not `SIGN_TRANSACTION` |

---

## Out of scope for this home test

- Funded deposits / Gate K trades / withdrawals broadcasting  
- Enabling `GATE_K_ALLOW_SIGN` or settlement live broadcast  
- Mainnet  

Stop after session + portfolio status UI. Report pass/fail + any error codes to Chat 1/2.
