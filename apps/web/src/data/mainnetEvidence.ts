/**
 * Independently verified NEAR mainnet evidence for NIO.
 *
 * RULES:
 * - Do not invent contract IDs, tx hashes, or funded-trade claims.
 * - Populate fields only after Chat 1 supplies verified on-chain proof.
 * - Testnet Gate K / Sepolia receipts must never be labeled as mainnet.
 */

export type NearNetworkId = "testnet" | "mainnet";

export type MainnetCapability =
  | "contract_deployed"
  | "policy_active"
  | "mpc_ready"
  | "live_trading_enabled"
  | "funded_settlement_proven";

export type MainnetEvidenceRecord = {
  /** Must be exactly "mainnet" for any displayed mainnet proof. */
  network: "mainnet";
  /** ISO timestamp when Chat 1 verified this pack. */
  verified_at: string | null;
  /** Human source note (doc / evidence file / operator attestation). */
  verification_source: string | null;
  contract: {
    account_id: string | null;
    deploy_tx: string | null;
    /** Optional code hash / WASM digest if independently recorded. */
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
    /** Derived EVM address if verified; never invent. */
    derived_evm_address: string | null;
    ready: boolean;
    integration_status: string;
  };
  intents: {
    /** Production Intents verifier (public platform contract), if referenced. */
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
  capabilities: Record<MainnetCapability, boolean>;
  /** Per-network verification — never mark LIVE without Chat 1 proof. */
  networks: {
    near: { status: "awaiting_evidence" | "partial" | "verified"; note: string };
    arbitrum: { status: "awaiting_evidence" | "partial" | "verified"; note: string };
    base: { status: "awaiting_evidence" | "partial" | "verified"; note: string };
    ethereum: { status: "awaiting_evidence" | "partial" | "verified"; note: string };
  };
  notes: string[];
};

/**
 * Empty / awaiting pack. Replace fields only when Chat 1 provides verified proof.
 * Until then the UI must show pending/blocked — never fake deployed contracts.
 */
export const MAINNET_EVIDENCE: MainnetEvidenceRecord = {
  network: "mainnet",
  verified_at: null,
  verification_source: null,
  contract: {
    account_id: null,
    deploy_tx: null,
    code_hash: null,
  },
  policy: {
    active: false,
    epoch: null,
    policy_hash: null,
    owner_account: null,
  },
  mpc: {
    signer_contract: null,
    derived_evm_address: null,
    ready: false,
    integration_status: "AWAITING_CHAT1_VERIFIED_PROOF",
  },
  intents: {
    verifier_account: null,
    quote_status: "NOT_VERIFIED",
    integration_status: "AWAITING_CHAT1_VERIFIED_PROOF",
  },
  funded_trade: {
    proven: false,
    tx_hash: null,
    amount_label: null,
    note: "No funded mainnet settlement has been independently verified for NIO yet.",
  },
  capabilities: {
    contract_deployed: false,
    policy_active: false,
    mpc_ready: false,
    live_trading_enabled: false,
    funded_settlement_proven: false,
  },
  networks: {
    near: {
      status: "awaiting_evidence",
      note: "Policy deploy + MPC reads pending Chat 1 verification",
    },
    arbitrum: {
      status: "awaiting_evidence",
      note: "No funded Arbitrum settlement proven",
    },
    base: {
      status: "awaiting_evidence",
      note: "No funded Base settlement proven",
    },
    ethereum: {
      status: "awaiting_evidence",
      note: "No funded Ethereum mainnet settlement proven",
    },
  },
  notes: [
    "Public judge Live AI remains testnet dry-run with may_sign=false.",
    "A verified testnet owner session does not authenticate a mainnet account.",
    "Mainnet trading controls stay disabled until Chat 1 confirms endpoint contracts and security gates.",
    "Token scope ANY_ELIGIBLE_TOKEN is never the default — owner must authorize explicitly.",
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
