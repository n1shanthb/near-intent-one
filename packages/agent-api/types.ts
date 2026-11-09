/**
 * Integration contract for product UI / agents (Gate H4).
 * Backend source of truth — do not invent values in the frontend.
 * apps/web should consume these shapes; this package does not edit apps/web.
 */

/** Policy limits + mandate epoch */
export type PolicySnapshot = {
  mandate_epoch: number;
  revoked: boolean;
  signing_revoked: boolean;
  policy_hash?: string;
  strategy_hash?: string;
  limits?: {
    max_trade_value: string;
    daily_turnover_limit: string;
    max_pending_exposure: string;
    max_slippage_bps: number;
    allowed_assets: string[];
    allowed_destinations: string[];
    valid_until: string;
  };
};

/** Exposure / accounting */
export type ExposureSnapshot = {
  reserved_pending_exposure: string;
  realized_exposure: string;
  revoked: boolean;
  mandate_epoch: number;
  unresolved_pending: number;
  signing_revoked: boolean;
  economically_settled: boolean;
};

export type AgentDecisionRecord = {
  choice: "TRADE" | "NO_TRADE";
  strategy_id: string;
  timestamp: string;
  amount_in: string;
  rationale: string;
  rejection_code: string | null;
  checks: Array<{ ok: boolean; name: string; [k: string]: unknown }>;
  quote_summary: {
    correlationId: string | null;
    depositAddress: string;
    amountIn: string;
    minAmountOut: string;
    deadline: string | null;
  } | null;
  correlation_id?: string | null;
  deposit_address?: string;
  min_amount_out?: string;
  source: "live_gate_h";
};

export type QuoteAuthorization = {
  trust_model: "trusted_attestor_not_tidepool_maker";
  attestation_id?: string;
  ok: boolean;
  deposit_address?: string;
  amount_in?: string;
  reject_reason?: string;
};

export type MpcSigningRecord = {
  operation_id: string;
  propose_tx?: string;
  request_signature_tx?: string;
  signature_found: boolean;
};

export type SwapSettlementRecord = {
  operation_id: string;
  origin_tx?: string;
  origin_status?: string;
  tidepool_status?: string;
  near_settlement_txs?: string[];
  reconcile_tx?: string;
  settlement_state?:
    | "Success"
    | "Failed"
    | "Refunded"
    | "Expired"
    | "Reconciled"
    | "Pending";
  /** evidence_hash is stored on-chain; not independently verified by the contract */
  evidence_hash?: string;
  verification: "trusted_offchain_watchdog_not_onchain_proof";
};

export type LedgerConnectionState = {
  connected: boolean;
  proven: boolean;
  owner_account: string;
  software_full_access_count: number;
  ledger_full_access_present: boolean;
  last_hardware_set_policy_tx: string | null;
  last_hardware_revoke_tx: string | null;
  status: "BLOCKED" | "READY" | "PROVEN";
  reason?: string;
};

export type RevocationStatus = {
  revoked: boolean;
  mandate_epoch: number;
  active_signing_requests: number;
  unresolved_pending: number;
  fully_revoked: boolean;
};

export type ReconcilerStatus = {
  reconciler_account: string | null;
  /** true if reconciler === trading agent (discouraged) */
  colocated_with_agent: boolean;
  trust_note: string;
};

export type UpgradeAuthorityAudit = {
  contract_account: string;
  full_access_keys: Array<{ public_key: string; permission: unknown }>;
  risk: string;
  mitigation: string;
  owner_controls_upgrade: boolean;
};

/** Aggregate backend surface the product may poll */
export type AgentBackendSnapshot = {
  network: "testnet";
  accounts: {
    owner: string;
    agent: string;
    contract: string;
    reconciler: string | null;
  };
  policy: PolicySnapshot;
  exposure: ExposureSnapshot;
  revocation: RevocationStatus;
  reconciler: ReconcilerStatus;
  ledger: LedgerConnectionState;
  upgrade_authority: UpgradeAuthorityAudit;
  latest_decision: AgentDecisionRecord | null;
  latest_settlement: SwapSettlementRecord | null;
};
