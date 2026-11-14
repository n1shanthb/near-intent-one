/**
 * Independently verified NEAR mainnet evidence for NIO.
 * Populated from owner Ledger txs + live policy reads (2026-11-14).
 */

export type NearNetworkId = "testnet" | "mainnet";

export type MainnetCapability =
  | "contract_deployed"
  | "policy_active"
  | "mpc_ready"
  | "deposit_capability_enabled"
  | "custody_recovery_documented"
  | "live_trading_enabled"
  | "funded_settlement_proven";

export type MainnetEvidenceRecord = {
  network: "mainnet";
  verified_at: string | null;
  verification_source: string | null;
  contract: {
    account_id: string | null;
    deploy_tx: string | null;
    code_hash: string | null;
  };
  policy: {
    active: boolean;
    epoch: number | null;
    policy_hash: string | null;
    owner_account: string | null;
  };
  mpc: {
    signer_contract: string | null;
    derived_evm_address: string | null;
    ready: boolean;
    integration_status: string;
  };
  intents: {
    verifier_account: string | null;
    quote_status: string;
    integration_status: string;
  };
  funded_trade: {
    proven: boolean;
    tx_hash: string | null;
    amount_label: string | null;
    note: string | null;
  };
  autonomy: {
    activated: boolean;
    activate_tx: string | null;
    unpause_tx: string | null;
    migrate_tx: string | null;
    autonomous_trading: boolean;
    enforce_autonomous_on_agent: boolean;
    live_no_trade_decision_hash: string | null;
  };
  capabilities: Record<MainnetCapability, boolean>;
  networks: {
    near: { status: "awaiting_evidence" | "partial" | "verified"; note: string };
    arbitrum: { status: "awaiting_evidence" | "partial" | "verified"; note: string };
    base: { status: "awaiting_evidence" | "partial" | "verified"; note: string };
    ethereum: { status: "awaiting_evidence" | "partial" | "verified"; note: string };
  };
  notes: string[];
};

export const MAINNET_EVIDENCE: MainnetEvidenceRecord = {
  network: "mainnet",
  verified_at: "2026-11-14T13:29:23Z",
  verification_source: "docs/evidence/MAINNET_SHIP_STATUS.json + Nearblocks txs",
  contract: {
    account_id: "policy.nishanthb.near",
    deploy_tx: "7rxXmYqbDL7HyBtG2EKo4g1xHbJYptphg9jMLU7Konrf",
    code_hash: "ARJJNXWAqrN1fD76rVAFictk1ioasfwSyQaiofWerMpc",
  },
  policy: {
    active: true,
    epoch: 3,
    policy_hash: "nio-mainnet-demo-mandate-v1",
    owner_account: "nishanthb.near",
  },
  mpc: {
    signer_contract: "v1.signer",
    derived_evm_address: "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4",
    ready: true,
    integration_status: "DERIVED_ADDRESS_VERIFIED",
  },
  intents: {
    verifier_account: null,
    quote_status: "VENUE_ALLOWED_near_intents_1click",
    integration_status: "PERMITTED_BY_POLICY",
  },
  funded_trade: {
    proven: false,
    tx_hash: null,
    amount_label: null,
    note: "No autonomous mainnet trade settled. LIVE_LLM chose NO_TRADE (b9cba80b…). Prior canaries were SUPERVISED.",
  },
  autonomy: {
    activated: true,
    activate_tx: "6zQs6C56tdPYz5BYY9Ca2T4XusU5oavt1gDw3tdDaW93",
    unpause_tx: "9jaW3jv5z2adx8aV6xXhfvCstxeKrRaQp2e8SEHX61Fy",
    migrate_tx: "3XHBXDPWMhmDymZdh4NrVZfxYwp9DqcbekLVVrxVSYME",
    autonomous_trading: true,
    enforce_autonomous_on_agent: true,
    live_no_trade_decision_hash:
      "b9cba80b576d475d1ce0509ac8543d6119b882f94603e9d8bee47f06c5cefbf9",
  },
  capabilities: {
    contract_deployed: true,
    policy_active: true,
    mpc_ready: true,
    deposit_capability_enabled: false,
    custody_recovery_documented: true,
    live_trading_enabled: true,
    funded_settlement_proven: false,
  },
  networks: {
    near: {
      status: "verified",
      note: "Policy deployed + mandate epoch 3 + autonomous unpaused",
    },
    arbitrum: {
      status: "partial",
      note: "In allowlist (PERMITTED BY POLICY); no autonomous settlement proven",
    },
    base: {
      status: "partial",
      note: "In allowlist (PERMITTED BY POLICY); no autonomous settlement proven",
    },
    ethereum: {
      status: "partial",
      note: "In allowlist (PERMITTED BY POLICY); no autonomous settlement proven",
    },
  },
  notes: [
    "Mainnet autonomy activated 2026-11-14 via owner Ledger.",
    "Autonomous LIVE_LLM decision was NO_TRADE — valid refusal, not a settled trade.",
    "Decision audit WASM (record_decision_cycle) is prepared; on-chain receipts require separate owner Ledger upgrade.",
    "Supervised Mission 1/2 canaries must not be labeled autonomous mainnet trades.",
  ],
};

export function hasVerifiedMainnetContract(
  ev: MainnetEvidenceRecord = MAINNET_EVIDENCE
): boolean {
  return Boolean(
    ev.network === "mainnet" &&
      ev.verified_at &&
      ev.contract.account_id &&
      ev.capabilities.contract_deployed
  );
}

export function hasAnyMainnetProof(
  ev: MainnetEvidenceRecord = MAINNET_EVIDENCE
): boolean {
  return hasVerifiedMainnetContract(ev) || ev.capabilities.funded_settlement_proven;
}
