# Checkpoint J2 — Isolated agent operational key (PREP ONLY)

**Broadcast / mainnet mutations:** NONE  
**Policy preserved:** `paused=true`, `autonomous_trading=false`, `funded_trading=false`  
**Prepared at:** 2026-11-13T04:05Z

## Reconfirm — agent.nishanthb.near

| Check | Result |
|-------|--------|
| Exists | Yes |
| Balance | 0.500 NEAR (available ≈ 0.5; storage may show ~0.498 in wallets) |
| Access keys | **Exactly one** FullAccess |
| Key | `ed25519:7AMsxZH3HdjRj9twcR2aXyVUdYJZNzgy6ZeRajwkBx58` (Ledger) |
| Owner remaining | ≈ 2.735 NEAR |

## Policy (unchanged)

| Field | Value |
|-------|-------|
| `get_paused` | `true` |
| `get_autonomous_trading` | `false` |
| `get_mandate_epoch` | `2` |
| Funded trading | OFF (not configured in this step) |

## New agent operational PUBLIC key

```
ed25519:DZUECSrU7kcqzN1PcSBGRgqf6uegsbTFxQ8wbDBxEbgJ
```

## Secure file path (private key — do not open in chat/screenshots)

```
C:\Users\Nishanth\.nio-secure\mainnet-agent-ops\agent.nishanthb.near.ops.2026-11-13T04-05-02-764Z.json
```

ACL (Windows): inheritance removed; `TOPG\Nishanth:(F)` + `NT AUTHORITY\SYSTEM:(F)` only.

## Match & isolation

| Check | Result |
|-------|--------|
| Public/private key match | **PASS** |
| Local sign verify | **PASS** |
| Construction test (no broadcast) | **PASS** |
| Ops pubkey on agent (before AddKey) | absent |
| Ops pubkey on `nishanthb.near` | absent |
| Ops pubkey on `policy.nishanthb.near` | absent |
| Isolation | **PASS** |

## Exact Ledger AddKey command (DO NOT RUN until approved)

```powershell
$near = "$env:USERPROFILE\bin\near-cli-rs\near-cli-rs-x86_64-pc-windows-msvc\near.exe"
$HD = "m/44'/397'/0'/0'/1'"
$OPS = "ed25519:DZUECSrU7kcqzN1PcSBGRgqf6uegsbTFxQ8wbDBxEbgJ"

& $near account add-key agent.nishanthb.near `
  grant-full-access `
  use-manually-provided-public-key $OPS `
  network-config mainnet `
  sign-with-ledger --seed-phrase-hd-path $HD `
  usb
```

Unsigned preview (already constructed with `sign-later`; nonce/block-hash expire — CLI refreshes on live Ledger sign):

```text
signer_id:    agent.nishanthb.near
receiver_id:  agent.nishanthb.near
actions:
  -- add access key:
        public key:   ed25519:DZUECSrU7kcqzN1PcSBGRgqf6uegsbTFxQ8wbDBxEbgJ
        nonce:        0
        permission:   FullAccess
```

**Expected transaction:** only `AddKey` FullAccess of the new ops public key on `agent.nishanthb.near`. No Transfer, no FunctionCall, no owner/policy touch.

Saved unsigned base64 (reference): `%USERPROFILE%\.nio-secure\mainnet-agent-ops\addkey-ops-unsigned.json`

## Emergency Ledger DeleteKey (recovery — after AddKey exists)

```powershell
$near = "$env:USERPROFILE\bin\near-cli-rs\near-cli-rs-x86_64-pc-windows-msvc\near.exe"
$HD = "m/44'/397'/0'/0'/1'"
$OPS = "ed25519:DZUECSrU7kcqzN1PcSBGRgqf6uegsbTFxQ8wbDBxEbgJ"

& $near account delete-keys agent.nishanthb.near `
  public-keys $OPS `
  network-config mainnet `
  sign-with-ledger --seed-phrase-hd-path $HD `
  usb
```

### Recovery caveat (critical)

An agent **FullAccess** ops key can itself call `DeleteKey` on the Ledger recovery key. After compromise of the ops private key, **Ledger recovery is not guaranteed** unless the attacker has not yet removed the Ledger key. Treat ops-key theft as urgent: DeleteKey the ops key from Ledger immediately if the Ledger key is still present; rotate; consider draining/recreating the agent account if the Ledger key was removed.

## Signing-adapter readiness

| Item | Status |
|------|--------|
| Load secure file → `InMemoryKeyStore` (`networkId=mainnet`) | **PASS** (local construction/sign verify; no broadcast) |
| Keystore holds owner/policy keys | No |
| Public frontend / repo / chat exposure | None (path outside workspace; private key not printed) |
| Production unattended backend (`api-server.mjs` / `near-live.mjs`) | **BLOCKED** — still hardcoded `testnet` + repo `.near-credentials/testnet` |

**Verdict: PASS (secure load proven) / BLOCKED (unattended mainnet enablement)**

## Production secret-management proposal (before unattended enable)

1. **Store:** Windows DPAPI or OS credential store wrapping the file under `%USERPROFILE%\.nio-secure\mainnet-agent-ops\` (current ACL is interim). Prefer encrypted-at-rest + machine-bound unwrap for the agent host only.
2. **Runtime:** Backend-only env `NIO_AGENT_OPS_KEY_PATH` (absolute path). Loader uses `InMemoryKeyStore` + `networkId=mainnet`. Never mount into web/static, never send to browser, never log file contents or private_key fields.
3. **Process isolation:** Agent signer process separate from public API if possible; API receives only signed tx hashes / status.
4. **Rotation:** Documented AddKey new ops + Ledger DeleteKey old; revoke policy agent session if compromised.
5. **Do not** copy into `.near-credentials/mainnet/` inside the git worktree; keep `.nio-secure/` outside synced folders and add to `.gitignore`.
6. Unattended trading remains off until attestor, EVM funding, and explicit unpause approvals (separate checkpoints).

## Explicitly NOT done

- No mainnet broadcast / AddKey send  
- No unpause / autonomous / funded_trading enable  
- No EVM funding  
- No trusted quote signing configuration  
