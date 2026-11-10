/**
 * Gate I3 — independently scoped reconciler.
 * Verifies off-chain before reconcile_pending. No agent trade keys.
 */
import {
  verifyBeforeReconcile,
  deriveSettlementState,
} from "../reconcile/verify-settlement.mjs";
import { createHash } from "node:crypto";

export function createReconcilerService({
  nearAccount,
  store,
  logger = console,
}) {
  return {
    health() {
      return {
        ok: true,
        role: "reconciler",
        account: nearAccount?.accountId || null,
      };
    },
    async reconcile({
      policyContract,
      operationId,
      pendingOp,
      originTxHash,
      expectedSender,
      expectedToken,
      expectedRecipient,
      expectedAmount,
      depositAddress,
    }) {
      const idem = `reconcile:${policyContract}:${operationId}`;
      const existing = store.read().executions[idem];
      if (existing?.status === "SUCCESS") {
        return { ok: true, idempotent: true, prior: existing };
      }
      store.beginExecution(idem, {
        kind: "reconcile",
        policyContract,
        operationId,
      });

      const verified = await verifyBeforeReconcile({
        pendingOp,
        originTxHash,
        expectedSender,
        expectedToken,
        expectedRecipient,
        expectedAmount,
        depositAddress,
      });
      const derived = deriveSettlementState({
        pendingOp,
        originVerified: verified.origin || verified,
        tidepoolVerified: verified.tidepool || { ok: false },
        originTxHash,
      });

      if (!derived.ok || derived.settlement_state !== "Success") {
        store.finishExecution(idem, {
          status: "FAILED",
          reason: derived.reason || "verify_failed",
          verified,
          derived,
        });
        return { ok: false, verified, derived };
      }

      const evidence_hash = createHash("sha256")
        .update(
          JSON.stringify({
            operationId,
            originTxHash,
            derived,
            at: new Date().toISOString(),
          })
        )
        .digest("hex");

      const tx = await nearAccount.functionCall({
        contractId: policyContract,
        methodName: "reconcile_pending",
        args: {
          operation_id: operationId,
          settlement_state: "Success",
          evidence_hash,
        },
        gas: BigInt("50000000000000"),
        attachedDeposit: 0n,
      });

      store.finishExecution(idem, {
        status: "SUCCESS",
        tx: tx.transaction.hash,
        evidence_hash,
        verified_onchain: false,
      });
      logger.info?.(
        `[reconciler] SUCCESS ${operationId} tx=${tx.transaction.hash}`
      );
      return {
        ok: true,
        tx: tx.transaction.hash,
        evidence_hash,
        verified_onchain: false,
      };
    },
  };
}
