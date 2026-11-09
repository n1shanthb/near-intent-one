/**
 * Gate H adapters — align with packages/agent-api/types.ts shapes.
 * Ownership VERIFIED from recorded H1 evidence; device CONNECTED is session-only.
 */

import {
  H3_DECISION,
  H3_EXECUTION,
  HARDWARE_OWNERSHIP,
  MANDATE_AFTER_H1,
} from "../data/evidenceSnapshot";

/** Mirrors packages/agent-api/types.ts — keep in sync manually. */
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
  evidence_hash?: string;
  verification: "trusted_offchain_watchdog_not_onchain_proof";
};

export type StrategyDecisionLog = AgentDecisionRecord & {
  execution?: {
    operationId: string;
    mpcSignTx: string;
    sepoliaTx: string;
    tidepoolStatus: string;
    reconcileTx: string;
  };
};

export interface GateHLedger {
  isConnected(): Promise<boolean>;
  /** Historic/on-chain hardware ownership PASS (H1). */
  isOwnershipVerified(): Promise<boolean>;
  /** Live device session — independent of ownership. */
  getConnectionState(): Promise<LedgerConnectionState>;
  wizardPath(): string;
}

export interface GateHStrategy {
  getLatestDecision(): Promise<StrategyDecisionLog | null>;
  getLatestSettlement(): Promise<SwapSettlementRecord | null>;
}

let connectedHint = false;

export function notifyLedgerSession(connected: boolean) {
  connectedHint = connected;
}

/** @deprecated use isOwnershipVerified — kept for older callers */
export function notifyLedgerProven(_proven: boolean) {
  /* ownership comes from recorded evidence, not session */
}

export const gateHLedger: GateHLedger = {
  async isConnected() {
    return connectedHint;
  },
  async isOwnershipVerified() {
    return HARDWARE_OWNERSHIP.verified;
  },
  async getConnectionState() {
    return {
      connected: connectedHint,
      proven: HARDWARE_OWNERSHIP.verified,
      owner_account: HARDWARE_OWNERSHIP.ownerAccount,
      software_full_access_count: 0,
      ledger_full_access_present: true,
      last_hardware_set_policy_tx: HARDWARE_OWNERSHIP.setPolicyTx,
      last_hardware_revoke_tx: HARDWARE_OWNERSHIP.revokeTx,
      status: HARDWARE_OWNERSHIP.verified ? "PROVEN" : "BLOCKED",
      reason: connectedHint
        ? "Device session active"
        : "Device disconnected — ownership still historically VERIFIED",
    };
  },
  wizardPath() {
    return "/setup/ledger";
  },
};

export const gateHStrategy: GateHStrategy = {
  async getLatestDecision() {
    return {
      choice: H3_DECISION.choice,
      strategy_id: H3_DECISION.strategy_id,
      timestamp: H3_DECISION.timestamp,
      amount_in: H3_DECISION.amount_in,
      rationale: H3_DECISION.rationale,
      rejection_code: H3_DECISION.rejection_code,
      checks: H3_DECISION.checks,
      quote_summary: H3_DECISION.quote_summary,
      correlation_id: H3_DECISION.quote_summary.correlationId,
      deposit_address: H3_DECISION.quote_summary.depositAddress,
      min_amount_out: H3_DECISION.quote_summary.minAmountOut,
      source: "live_gate_h",
      execution: {
        operationId: H3_EXECUTION.operationId,
        mpcSignTx: H3_EXECUTION.mpcSignTx,
        sepoliaTx: H3_EXECUTION.sepoliaTx,
        tidepoolStatus: H3_EXECUTION.tidepoolStatus,
        reconcileTx: H3_EXECUTION.reconcileTx,
      },
    };
  },
  async getLatestSettlement() {
    return {
      operation_id: H3_EXECUTION.operationId,
      origin_tx: H3_EXECUTION.sepoliaTx,
      origin_status: H3_EXECUTION.sepoliaStatus,
      tidepool_status: H3_EXECUTION.tidepoolStatus,
      near_settlement_txs: H3_EXECUTION.nearSettlementTxs,
      reconcile_tx: H3_EXECUTION.reconcileTx,
      settlement_state: "Success",
      evidence_hash: H3_EXECUTION.nearSettlementTxs[0],
      verification: "trusted_offchain_watchdog_not_onchain_proof",
    };
  },
};

export function recordedMandateHint() {
  return MANDATE_AFTER_H1;
}
