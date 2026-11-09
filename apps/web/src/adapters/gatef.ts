/**
 * Gate F/H handoff — recorded F4 cycle + Ledger wizard for owner ops.
 */

import { F4_EXECUTION, HARDWARE_OWNERSHIP } from "../data/evidenceSnapshot";
import { H3_EXECUTION } from "../data/evidenceSnapshot";

export type OwnerMethod =
  | "set_policy"
  | "revoke"
  | "unrevoke"
  | "set_trusted_quote_signer";

export type LedgerHandoffResult =
  | { status: "ready_for_ledger"; requestId: string; summary: string; wizardPath: string }
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
  label?: string;
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
  getLatestStrategyReceipt(): Promise<UnattendedReceipt | null>;
}

export const gateFLedger: GateFLedgerHandoff = {
  async prepareOwnerCall({ method }) {
    if (!HARDWARE_OWNERSHIP.verified) {
      return {
        status: "blocked",
        reason: "Hardware ownership not verified.",
      };
    }
    return {
      status: "ready_for_ledger",
      requestId: `owner-${method}-${Date.now()}`,
      wizardPath: "/setup/ledger",
      summary: `Ownership VERIFIED (${HARDWARE_OWNERSHIP.ledgerPublicKey}). Open Ledger setup to physically sign ${method}. Proposed JSON is NOT approved until the device confirms. Mandate is currently revoked at epoch ${HARDWARE_OWNERSHIP.revokeVerified.mandate_epoch} — unrevoke only via Ledger if needed.`,
    };
  },
  async awaitHardwareApproval() {
    return {
      status: "unavailable",
      reason:
        "Complete signing in /setup/ledger with the physical device. This UI does not forge approvals.",
    };
  },
};

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
      label: "F4",
    };
  },
  async getLatestStrategyReceipt() {
    return {
      operationId: H3_EXECUTION.operationId,
      correlationId: "45adf4ce-1a01-4d37-bc0e-3cf6d20251d4",
      settlement: "Success",
      nearProposeTx: H3_EXECUTION.proposeTx,
      mpcSignTx: H3_EXECUTION.mpcSignTx,
      evmBroadcastTx: H3_EXECUTION.sepoliaTx,
      nearSettlementTx: H3_EXECUTION.nearSettlementTxs[0],
      reconcileTx: H3_EXECUTION.reconcileTx,
      amountIn: "1000000",
      trustModel: "trusted_attestor",
      source: "recorded_verified_evidence",
      label: "H3",
    };
  },
};

export function isGateFLive(): boolean {
  return false;
}

export function isGateF4Recorded(): boolean {
  return true;
}
