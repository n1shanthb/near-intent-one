/**
 * Gate F integration boundary.
 * Recorded F4 evidence is available; live Ledger remains blocked until Gate H.
 */

import { F4_EXECUTION } from "../data/evidenceSnapshot";

export type OwnerMethod =
  | "set_policy"
  | "revoke"
  | "unrevoke"
  | "set_trusted_quote_signer";

export type LedgerHandoffResult =
  | { status: "ready_for_ledger"; requestId: string; summary: string }
  | { status: "blocked"; reason: string };

export type LedgerApprovalResult =
  | { status: "signed"; nearTxHash: string }
  | { status: "rejected" | "blocked" | "unavailable"; reason: string };

export type UnattendedReceipt = {
  operationId: string;
  correlationId: string;
  settlement: "Success" | "Failed" | "Refunded" | "Expired" | "Pending";
  nearProposeTx?: string;
  mpcSignTx?: string;
  evmBroadcastTx?: string;
  nearSettlementTx?: string;
  reconcileTx?: string;
  amountIn?: string;
  trustModel: "trusted_attestor";
  source: "recorded_verified_evidence" | "live";
};

export interface GateFLedgerHandoff {
  prepareOwnerCall(args: {
    method: OwnerMethod;
    args: Record<string, unknown>;
  }): Promise<LedgerHandoffResult>;
  awaitHardwareApproval(requestId: string): Promise<LedgerApprovalResult>;
}

export interface GateFAgentCycle {
  getLastUnattendedReceipt(): Promise<UnattendedReceipt | null>;
}

/** Ledger path still blocked (F3/G/H). */
export const gateFLedger: GateFLedgerHandoff = {
  async prepareOwnerCall({ method }) {
    return {
      status: "blocked",
      reason: `Ledger NOT CONNECTED / NOT PROVEN (Gate F3/G BLOCKED; Gate H in progress). Requested ${method} will not be treated as approved.`,
    };
  },
  async awaitHardwareApproval() {
    return {
      status: "unavailable",
      reason: "Physical Ledger confirmation not demonstrated.",
    };
  },
};

/** Returns recorded F4 PASS receipt — not a live agent poll. */
export const gateFAgent: GateFAgentCycle = {
  async getLastUnattendedReceipt() {
    return {
      operationId: F4_EXECUTION.operationId,
      correlationId: F4_EXECUTION.correlationId,
      settlement: "Success",
      nearProposeTx: F4_EXECUTION.proposeTx,
      mpcSignTx: F4_EXECUTION.mpcSignTx,
      evmBroadcastTx: F4_EXECUTION.sepoliaTx,
      nearSettlementTx: F4_EXECUTION.nearSettlementTxs[0],
      reconcileTx: F4_EXECUTION.reconcileTx,
      amountIn: F4_EXECUTION.amountIn,
      trustModel: "trusted_attestor",
      source: "recorded_verified_evidence",
    };
  },
};

export function isGateFLive(): boolean {
  return false;
}

export function isGateF4Recorded(): boolean {
  return true;
}
