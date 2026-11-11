# P0–P4 Report — Custody proof + Ledger rehearsal readiness

**Date:** 2026-11-11  
**Mainnet signing/broadcast:** OFF  
**Public funded-agent access:** OFF

## 1. Exact destination recipient (prior SUCCESS trade)

`0x30af279bedef3bb82c7f47bb9f6a514f6264e752` on `wnear.tidepool-sandbox.testnet` (NEP-141), amount `263247070370370421104000`.

## 2. Independently verified asset balance

- Prior trade: `ft_balance_of(0x30af…)` = `7313347300037944920013600` (aggregate stuck credits); policy/owner = `0`.
- Recoverable trade: `ft_balance_of(nio-i-a4e7-a-owner.testnet)` = `263260765079365092512000` after SUCCESS.

## 3. Custody and withdrawal control verdict

| Trade | Verdict |
|-------|---------|
| EVM-as-NEAR DESTINATION_CHAIN | **CUSTODY FAILURE** — account uncreateable; NIO cannot withdraw |
| Owner NEAR DESTINATION_CHAIN | **CUSTODY_VERIFIED_RECOVERABLE** — owner FullAccess; ft_transfer to policy proved |

## 4. Recovered funds

**None** from the failed destination (`OnlyImplicitAccountCreationAllowed`). New trade funds are under owner control.

## 5. Ledger CLI version and tested commands

- **near-cli-rs 0.31.1**
- Documented + executed: create-account (with initial balance), add-key, deploy+init (`file-args`), delete-keys, list-keys, `sign-as` owner call  
- See `docs/LEDGER_TEMP_KEY_DEPLOY_CEREMONY.md`

## 6. Real testnet deployment transaction hashes

| Step | Tx |
|------|-----|
| Create `policy-rehearse.nio-i-a4e7-a-owner.testnet` | `DpFGfjVHNNt67ycyYh8iuZBHCee1eWcfXnZAzACxKfSm` |
| Add temp FA | `3RdMg4zxwPQ8TwJdQCwavdgFzfwgP26n3ad82B4WxTWe` |
| Deploy+init paused WASM | `5vQthfEkhepjRk9mbi1SMxHMLreSGcq4wQcDQvbgppiD` |
| Delete temp key | `2nBspRf6RJBguJGG1jgXgWH4ksSpMJmYxFWMmjvNmMD6` |
| Owner pause | `DNdZTiQT1xpBCUVujXrPVMd3gDcFxjoZSGAu4py3AutD` |

## 7. Policy account key inventory after key removal

Rehearsal account keys after temp deletion:

- `ed25519:2TWST8ofn1XHDPGqTSnpTVcTexUZkx8yTHaKw2sX6ReN` — FullAccess only

(Existing live `policy.nio-i-a4e7-a-owner.testnet` was **not** overwritten.)

## 8. Final mainnet WASM hash

`3bc7c1120a1f593a4c96ff58171ce9521f780ceec0427d97f90f0cac9ecc4f90` (625701 bytes) — re-verified locally; on-chain code hash `52MidcEUUwVaiNcTtuQbKd1xwVQR8HGer4quihZj8FZZ`.

## 9. Mainnet inert deployment readiness

**CONDITIONAL GO for ceremony** after Ledger device rehearsal of the same command path. Software-key testnet rehearsal PASS. Mainnet broadcast still **OFF**.

## 10. First funded production 1Click readiness

**NO-GO.** Tidepool ≠ production 1Click; stuck prior credits unresolved without admin; mainnet balances/ceremony Ledger path incomplete; production signing OFF.

## 11. GitHub commit

See repository HEAD after this evidence push.

## 12. Remaining blockers (severity)

1. **P0 residual:** ~7.31 wNEAR stuck at uncreateable `0x30af…` — needs Tidepool/token admin recovery  
2. **Ledger hardware** not yet exercised on create/delete-key/owner-sign path  
3. **Mainnet** deploy + approval JSON + unpause gate still closed  
4. **Production 1Click** integration / funded mainnet capital association still absent  
5. Arb/Base Sepolia capital still zero for multi-origin proof  
