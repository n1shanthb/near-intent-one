/**
 * Sanitized public Gate K evidence — no secrets, keys, or privileged payloads.
 * Source: evidence/live/gate-k-first-trade.json (Chat 1).
 *
 * Honesty: Fitter ECONOMIC_NOT_VIABLE + Critic REJECT; trade ran only after
 * explicit one-time operator acceptance override. Not autonomous safety PASS.
 */

export const GATE_K_FIRST_TRADE = {
  gate: "K" as const,
  mode: "AI_TESTNET_EXECUTION" as const,
  portfolio_id: "i-a-a4e7",
  network: "sepolia_testnet_only",
  authorized_at: "2026-11-10T10:35:22.994Z",
  max_spend_usdc: 26,
  proposed_usdc: 24.45,
  balance_before_usdc: 48.9,
  balance_after_usdc: 24.45,
  models: {
    researcher: "google/gemini-2.5-flash",
    strategist: "anthropic/claude-sonnet-4.6",
    critic: "openai/gpt-5.2",
  },
  ai: {
    strategist_choice: "TRADE" as const,
    pipeline_decision: "NO_TRADE" as const,
    fitter_outcome: "REJECTED" as const,
    fitter_reasons: ["ECONOMIC_NOT_VIABLE", "FITTER_REJECTED"],
    critic_verdict: "REJECT" as const,
    reason_codes: [
      "FITTER_REJECTED",
      "ECONOMIC_NOT_VIABLE",
      "CRITIC_VETO",
    ],
  },
  acceptance_override: {
    used: true,
    note: "Operator authorized Gate K acceptance: proceed despite ECONOMIC/CRITIC blocks",
    prior_block: [
      "FITTER_REJECTED",
      "ECONOMIC_NOT_VIABLE",
      "CRITIC_VETO",
    ],
  },
  mandate: {
    epoch: 3,
    policy_hash: "gate-i-closure-v1",
    autonomous_trading: false,
  },
  execution: {
    operation_id: "k-ai-1794306967858",
    near_propose_tx: "9PRNPfp5yKBBf7urgDzJ7bm85UV4D7fxr3YVzRo5edRx",
    near_sign_tx: "uYNeSaacKRrZryaypk9MufiLMCMHcfbXNgFABswvBaj",
    sepolia_tx:
      "0x867717ff730678d9588a915879721d7d67a8b7826008dd140f228a3e813965fe",
    sepolia_status: "0x1",
    sepolia_explorer:
      "https://sepolia.etherscan.io/tx/0x867717ff730678d9588a915879721d7d67a8b7826008dd140f228a3e813965fe",
    tidepool_status: "SUCCESS",
    reconcile_status: "Success",
    reconcile_tx: "9kZiaYim5T8USgV6NU9ps2GbPfyoPfsm7yA6NSsR3Rww",
    reconcile_actor: "nio-i-a4e7-recon.testnet",
  },
  labels: {
    live_ai_execution: "LIVE AI EXECUTION — PROVEN",
    autonomous_safety:
      "AUTONOMOUS SAFETY APPROVAL — NOT PROVEN BY THIS OVERRIDDEN TRADE",
  },
} as const;

export const NEARBLOCKS_TX = "https://testnet.nearblocks.io/txns";
