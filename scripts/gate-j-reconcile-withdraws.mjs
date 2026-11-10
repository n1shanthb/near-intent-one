#!/usr/bin/env node
/**
 * Reconcile Signed+None owner withdraws after Sepolia receipt verification.
 * Does NOT clear pending without a matching ERC-20 transfer receipt.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pickRpc,
  viewFunction,
  connectWithAccounts,
  USDC_SEPOLIA,
  assertNotDemo,
} from "./lib/near-live.mjs";
import {
  verifyBeforeReconcile,
  deriveSettlementState,
} from "../packages/reconcile/verify-settlement.mjs";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "evidence", "live");
mkdirSync(EVIDENCE, { recursive: true });

const POLICY = "policy.nio-i-a4e7-a-owner.testnet";
const RECON = "nio-i-a4e7-recon.testnet";
const SENDER = "0x30af279bedef3bb82c7f47bb9f6a514f6264e752";

/** Known Gate I withdraw receipt (0.1 USDC = 100000 raw) — do not invent. */
const KNOWN = {
  "i-wd-1794294110470": {
    originTxHash: "0x2d11b9a650b92f422c39edbe89002f4722598adf44367e0f6a79bcd89a33408d",
    expectedRecipient: "0x9950ce47498ab3a83b278879aa9f0e477346ac39",
    expectedAmount: "100000",
  },
};

async function main() {
  const rpc = await pickRpc();
  assertNotDemo(POLICY);
  assertNotDemo(RECON);
  const pending = await viewFunction(rpc, POLICY, "list_pending", {});
  const near = await connectWithAccounts(rpc, CREDS, [RECON]);
  const recon = await near.account(RECON);
  const out = {
    as_of: new Date().toISOString(),
    policy: POLICY,
    reconciler: RECON,
    results: [],
  };

  for (const op of pending) {
    if (op.settlement_state !== "None") continue;
    if (op.signing_state !== "Signed") continue;
    const known = KNOWN[op.operation_id];
    const row = {
      operation_id: op.operation_id,
      amount_in: op.amount_in,
      destination: op.destination,
      intent_payload: op.intent_payload,
    };
    if (!known) {
      row.status = "left_pending";
      row.reason =
        "no_verified_sepolia_receipt_mapping — refuse to clear Signed as Received";
      out.results.push(row);
      continue;
    }
    const verified = await verifyBeforeReconcile({
      pendingOp: op,
      originTxHash: known.originTxHash,
      expectedSender: SENDER,
      expectedToken: USDC_SEPOLIA,
      expectedRecipient: known.expectedRecipient,
      expectedAmount: known.expectedAmount,
    });
    const derived = deriveSettlementState({
      pendingOp: op,
      originVerified: verified.origin || verified,
      tidepoolVerified: verified.tidepool || { ok: false },
      originTxHash: known.originTxHash,
    });
    row.verified = {
      ok: verified.origin?.ok ?? verified.ok,
      derived,
    };
    if (!derived.ok || derived.settlement_state !== "Success") {
      row.status = "verify_failed_left_pending";
      out.results.push(row);
      continue;
    }
    const evidence_hash = createHash("sha256")
      .update(
        JSON.stringify({
          operationId: op.operation_id,
          originTxHash: known.originTxHash,
          derived,
          at: new Date().toISOString(),
        })
      )
      .digest("hex");
    const tx = await recon.functionCall({
      contractId: POLICY,
      methodName: "reconcile_pending",
      args: {
        operation_id: op.operation_id,
        settlement_state: "Success",
        evidence_hash,
      },
      gas: BigInt("50000000000000"),
      attachedDeposit: 0n,
    });
    row.status = "reconciled";
    row.near_tx = tx.transaction.hash;
    row.evidence_hash = evidence_hash;
    row.originTxHash = known.originTxHash;
    out.results.push(row);
  }

  const after = await viewFunction(rpc, POLICY, "get_gate_j_mandate", {});
  out.after = {
    unresolved_pending: after.unresolved_pending,
    reserved_pending_exposure: after.reserved_pending_exposure,
    realized_exposure: after.realized_exposure,
  };
  writeFileSync(
    join(EVIDENCE, "gate-j-pending-reconcile.json"),
    JSON.stringify(out, null, 2)
  );
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
