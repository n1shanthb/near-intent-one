# Checkpoint J4 — Restore real 1Click quotes (observation-only)

**Broadcast / Ledger / unpause / EVM funding:** NONE  
**Evidence:** `MAINNET_CHECKPOINT_J4_OBSERVE.json`  
**Node:** v22.13.0

## 1. TLS root cause + safe fix

| Item | Detail |
|------|--------|
| Root cause | College FortiGate SSL deep inspection (`issuer O=Fortinet`, `CN=FG7H0GTB26000084`) replaced the real Cloudflare/Google Trust leaf for `1click.chaindefuser.com`. Both Node and Windows curl/Schannel failed (`UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SEC_E_UNTRUSTED_ROOT`). Fortinet CA was **not** installed on the machine. |
| Forbidden bypasses | Not used: `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized:false`, `curl -k`. |
| Safe fix | Operator switched to **mobile hotspot**. Traffic bound via `NIO_BIND_ADDRESS` / auto-detect in `packages/mainnet/secureFetch.mjs` (IPv4 + `rejectUnauthorized:true`) so college Ethernet cannot steal the route. |
| Verified issuer on mobile | `Google Trust Services` / `WE1` — `fortinet_mitm: false` |

College net: reconnect anytime for NEAR/coding; 1Click will fail again until IT installs the FortiGate deep-inspection CA into Windows trust (then optional `NODE_EXTRA_CA_CERTS`).

## 2. HTTPS success

- TLS probe authorized: **true**
- `/v0/tokens`: **230** tokens, `tls: verified`
- Dry `/v0/quote` matrix: **15/18** routes `QUOTED` (3 `NO_SAFE_LIQUIDITY` — real API, not invented)

## 3. Four-chain dry matrix (1 USDC discovery)

Chains: NEAR, Ethereum, Arbitrum, Base. `dry=true`. Funded execution **DISABLED**. Eligible capital paths: **0** (honest zeros).

Best discovery (not authorization): `base_usdc_to_wrap_near` ≈ $0.9996 out USD.

Proposal: **NO_TRADE** (no verified capital).

## 4. AI observation (live quotes injected)

| Role | Result |
|------|--------|
| Researcher | ok |
| Strategist | **NO_TRADE** |
| Critic | APPROVE (advisory; cannot override pause) |
| Enforcement | **BLOCKED** / `POLICY_PAUSED` |
| Vetoes | POLICY_PAUSED, FUNDED_TRADING_OFF, BROADCAST_DISABLED, AUTONOMOUS_OFF, NO_VERIFIED_EVM_USDC |

Market fixture included `live_1click` matrix counts — not mock-only.

## 5. Safety preserved

`paused=true`, `autonomous_trading=false`, `funded_trading=false`, `mainnet_broadcast_enabled=false`, `autonomous_execution_enabled=false`.

## 6. Recommended next checkpoint

**J5 prep:** on a TLS-clean network, document IT FortiGate CA install for campus use; optionally prepare minimal EVM gas+USDC funding plan for the MPC address — still no unpause/broadcast until explicit approval.
