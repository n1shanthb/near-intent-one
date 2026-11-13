# Checkpoint J8A - First real mainnet trade preflight

**NO unpause / NO propose / NO request_signature / NO broadcast / NO escrow deposit**

## GO / NO-GO

- Preflight: **GO**
- Execution: **NO-GO**
- Local quote→attest→digest path PASS; execution awaits J8B owner Ledger unpause + explicit gate unlocks + operator confirm. Do not execute now.

## Live funding balances

| Chain | ETH | Native USDC | Nonce |
|-------|-----|-------------|-------|
| Arbitrum 42161 | 0.000063 (63000000000000 wei) | 2.000982 raw=2000982 | 0 |
| Base | 0 | 0 raw=0 | — |

Funding receipts: ETH `0x08d6a912d3b250f20b0c5d3dd6c5b724f0a060405b028fcc3a93159e5fba9ea4` ok=true · USDC `0x5a524ab39087965ac18c5b46c23287bb5eeef121ffa7d164ae2aa10dcd808e1d` ok=true

## Policy

- paused=true autonomous=false epoch=2 trusted=true
- intents_signer_id=0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4
- reserved_pending_exposure="0"
- arb/base USDC allowed=true/true mpc_dest=true

## Fresh quote

- result: **PASS** dry=false
- amount_in=1000000 amount_out=997398 min_out=994904
- floor: {"label":"j8a_fresh_nondry","amount_in":"1000000","min_amount_out":"994904","max_slippage_bps":100,"policy_floor":"990000","result":"PASS","altered_values":false}
- deposit: `0x274e83E4EcD364645a66eabd2548aaF38956044F`
- verify: {"ok":true,"verified":true,"reason":null,"quote_hash":"AkkDC2QPLkeAc9sBbbx79wdXYftTiMG9tyMVQGT7XSCi","escrow_in_signed_hash":true,"manager_key":"ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc","manager_key_mode":"pinned_official"}

## Gas / MPC tx compatibility

- eth_gasPrice=20016000 wei (0.020016 gwei)
- estimate=63344 (eth_estimateGas_from_mpc)
- chosen: {"ok":true,"blockers":[],"warnings":[{"code":"do_not_apply_sepolia_1gwei_floor","note":"gate-k 1 gwei floor is incompatible with attestor max_gas_price on Arbitrum; J8B must use live*1.5 capped at attestor max"}],"gas_limit":"100000","gas_price":"30024000","max_gas_price":"100000000","eth_need_at_proposed":"3002400000000","eth_need_at_ceiling":"10000000000000","eth_balance":"63000000000000","eth_covers_proposed":true,"eth_covers_ceiling":true}

## Local simulation

- attestation ok=true local_sig=true
- policy sim ok=true
- path_ok=true
- on_chain_mutated=false
- digest binding: {"policy_tx_to_means":"1click_escrow_deposit","policy_tx_to":"0x274e83e4ecd364645a66eabd2548aaf38956044f","eip155_tx_to_means":"erc20_token_contract","eip155_tx_to":"0xaf88d065e77c8cc2239327c5edb3a432268e5831","transfer_recipient_in_data":"0x274e83e4ecd364645a66eabd2548aaf38956044f","amount":"1000000","digest_hex":"f8ba46c754ad71158f8a6dda5a5d036f26e1c8449e2707980b0f3d87e4df4a37","digest_matches_buildErc20TxParams":true,"note":"On-chain propose binds policy.to==deposit and digest.to==token — both required"}

## J8B execution blockers (expected until owner unlocks)

- policy_paused_blocks_propose
- backend_funded_trading_gate_false
- backend_broadcast_gate_false

## J8B operator runbook (summary)

### Ledger
- L1: set_paused {"paused":false} — Unpause so agent can propose_quoted_evm_transfer
- L2-optional-emergency: set_paused {"paused":true} — Emergency re-pause
- L3-optional-emergency: remove_trusted_quote_signer {"public_key":"ed25519:6oqnd5mBShyMGGHCgrJEEEPtgAEsXzJEPfARf7Fc2CG9"} — Revoke attestor if compromise suspected

### Agent
- A0: Operator sets temporary execution env unlocks ONLY for this run
- A1: Fetch fresh non-dry 1Click quote (25 bps, 1 USDC Arb→Base, MPC recipient/refund)
- A2: Production attest with registered attestor key (pinned manager, escrow in hash, floor check)
- A3: agent.nishanthb.near → propose_quoted_evm_transfer
- A4: agent.nishanthb.near → request_signature(operation_id) with 1 yocto
- A5: Assemble EIP-155 raw tx (to=token, data=transfer(escrow,amount)) and eth_sendRawTransaction once

Full runbook JSON: see MAINNET_CHECKPOINT_J8A.json → j8b_runbook

## Mutations this checkpoint

```json
{
  "propose_quoted_evm_transfer": false,
  "request_signature": false,
  "eth_sendRawTransaction": false,
  "unpause": false,
  "escrow_deposit": false,
  "ledger_sign": false
}
```
