# Autonomous Mandate V1 — Threat Model

## Assets

- Owner NEAR account / Ledger seed  
- Policy contract authority (pause, limits, MPC path)  
- Agent FullAccess key (if used for 1-yocto MPC)  
- Attestor / reconciler credentials  
- Trading balances and commerce balances  
- OpenRouter API key  

## Adversaries

| Actor | Goal |
|-------|------|
| Stolen agent key | Drain within limits while unpaused |
| Malicious marketplace | Fake delivery / double spend commerce budget |
| Prompt injection via LLM | Coerce TRADE / BUY_DATA |
| Compromised API host | Forge “confirmations” or env bypass |
| Malicious reconciler | Mark Success without funds |

## Controls

1. **Contract:** pause/revoke/expiry/limits/digest; optional `enforce_autonomous_on_agent`  
2. **Keys:** agent never owns owner/policy; FC keys cannot attach MPC deposit  
3. **Off-chain:** shadow mode refuses mainnet mutations; OpenRouter spend kill switch; single-writer worker lock  
4. **Commerce:** mocked payments; separate budget; reserve-before-purchase  
5. **Evidence:** reconcile remains verified_onchain:false pointer — off-chain verify-first  

## Residual risks

- Already-signed in-flight MPC ops after revoke (document + pause early)  
- Agent FA can still move agent-account NEAR gas if funded  
- PLANNED interval/trade-count not on-chain yet  
- Marketplace not on-chain until later milestone  

## Fail-closed rules

No env, HTTP body, AI output, or local UI flag may bypass signed on-chain authority. Ambiguous chain outcomes → quarantine, never auto-retry irreversible steps.
