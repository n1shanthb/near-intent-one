# Checkpoint H — Mainnet deployment verification

**Verdict: PASS** (expected pre-funding gaps remain)

| Field | Value |
|-------|-------|
| Policy | `policy.nishanthb.near` |
| Owner | `nishanthb.near` |
| Code hash | `52MidcEUUwVaiNcTtuQbKd1xwVQR8HGer4quihZj8FZZ` |
| Local SHA-256 | `3bc7c1120a1f593a4c96ff58171ce9521f780ceec0427d97f90f0cac9ecc4f90` |
| `get_paused` | **true** |
| `get_autonomous_trading` | **false** |
| Temp FA | **absent** |
| Sole FA | `ed25519:7AMsxZH3HdjRj9twcR2aXyVUdYJZNzgy6ZeRajwkBx58` |

## Ceremony txs (mainnet RPC)

| Step | Hash | Status |
|------|------|--------|
| AddKey temp | `EnJbg2ny72wLsQMgpVTtMQkXXFPiYwd1aCVCpP1DAkkN` | Success |
| Deploy + `new` | `7dP54cvyDvy3FY97a6oBvUfLHhnVzhixxFCAVVKW21wU` | Success |
| DeleteKey temp | `A6Ygy6UdFLNr7fibFbXv2obeGEUU1fWWfHN95FctckKj` | Success |

## Views

- owner / agent / mpc / verifying / portfolio / path / epoch — see `MAINNET_CHECKPOINT_H_VERIFY.json`
- Four-chain allowlist matches live 1Click USDC (Eth/Arb/Base) + NEAR USDC/USDT/wNEAR (+ WETH legs)
- `allowed_destinations`: only `nishanthb.near` (no EVM MPC bound yet)

## Expected gaps before funded execution

1. MPC EVM address not bound / `intents_signer_id` empty  
2. Raw-unit risk caps (USDC-6 semantics)  
3. Agent account not provisioned  
4. Funded signing/broadcast must stay OFF  

Temp private key material deleted from `~.nio-secure/mainnet-temp-deploy/` after key-absence confirmation.
