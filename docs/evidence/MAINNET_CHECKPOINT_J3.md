# Checkpoint J3 — Mainnet agent backend (observation-only)

**Broadcast / Ledger / unpause / EVM funding:** NONE  
**Evidence:** `MAINNET_CHECKPOINT_J3_OBSERVE.json`

## Wiring

| Item | Status |
|------|--------|
| Dedicated process | `packages/services/mainnet-api-server.mjs` |
| Testnet isolation | `api-server.mjs` remains testnet-only; refuses `NIO_AGENT_OPS_KEY_PATH` |
| Ops key source | `NIO_AGENT_OPS_KEY_PATH` (outside repo) |
| Expected ops pubkey | `ed25519:DZUECSrU7kcqzN1PcSBGRgqf6uegsbTFxQ8wbDBxEbgJ` |
| Startup validation | PASS (key on agent only; owner/policy absent; paused; autonomous false; epoch from chain) |
| Local sign construction | PASS (digest only logged; no signed bytes) |
| Broadcast gates | `funded_trading=false`, `mainnet_broadcast_enabled=false`, `autonomous_execution_enabled=false` |

## Live observation (2026-11-13)

| Field | Result |
|-------|--------|
| Agent NEAR | ≈ 0.49996 available |
| Mandate epoch | **2** (on-chain) |
| Paused / autonomous | `true` / `false` |
| MPC EVM | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` MATCH |
| ETH / Arb / Base native+USDC | **0** verified on all three |
| Gate J (multi-model) | Ran; enforcement **BLOCKED** / `POLICY_PAUSED`; strategist **NO_TRADE** |
| 1Click catalog/quotes | **UNAVAILABLE** — host TLS `unable to verify the first certificate` to `1click.chaindefuser.com` |
| Broadcast probe | **BLOCKED** |

## Production secret management (required before unattended)

1. Keep ops private key **off** Vercel/GitHub/Cursor logs/browser (`VITE_*` forbidden).
2. Prefer OS DPAPI (Windows) or cloud KMS → unwrap to tmpfs / ACL’d file at boot; set `NIO_AGENT_OPS_KEY_PATH`.
3. Backend-only process; never mount secret into web static assets.
4. Rotate via Ledger AddKey + DeleteKey; treat FullAccess compromise as urgent.
5. Do not enable `NIO_MAINNET_ALLOW_BROADCAST` / funded trading until a later checkpoint.

## Remaining blockers for production execution

1. Policy still **paused**; autonomous/funded OFF.  
2. MPC EVM address **unfunded** (0 USDC / 0 gas on ETH/Arb/Base).  
3. Trusted quote signing / attestor not configured for mainnet execute.  
4. 1Click API TLS/JWT reachability from the operator host (catalog currently TLS-fail).  
5. Unattended secret unwrap + mainnet execute path still explicitly disabled in J3 gates.

## Recommended next step

**Checkpoint J4 prep:** fix operator-host trust for `1click.chaindefuser.com` (or supply partner JWT on a TLS-clean host), re-run dry four-chain quote matrix observation-only — still no broadcast / no unpause / no EVM funding.
