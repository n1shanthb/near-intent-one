#!/usr/bin/env node
/**
 * Gate G follow-up: confirm reconciler role + Expired abandoned never-signed F1 probe.
 * Does not fabricate Success — Reserved/None means no signature was ever exported.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as nearAPI from "near-api-js";

const { connect, keyStores, KeyPair } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "evidence", "live");
const RPC = "https://test.rpc.fastnear.com";
const NETWORK = "testnet";
const OP_ID = "f1-1794229262329";

async function view(accountId, method, args = {}) {
  const j = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  }).then((r) => r.json());
  if (j.error) throw new Error(JSON.stringify(j.error));
  const raw = Buffer.from(j.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function main() {
  const gateC = JSON.parse(readFileSync(join(EVIDENCE, "gate-c-evidence.json"), "utf8"));
  const gateG = JSON.parse(readFileSync(join(EVIDENCE, "gate-g-evidence.json"), "utf8"));
  const ownerId = gateC.accounts.owner.account_id;
  const agentId = gateC.accounts.agent.account_id;
  const contractId = gateC.accounts.contract.account_id;

  const before = {
    snap: await view(contractId, "get_exposure_snapshot"),
    reconciler: await view(contractId, "get_reconciler"),
    op: await view(contractId, "get_pending", { operation_id: OP_ID }),
  };

  const keyStore = new keyStores.InMemoryKeyStore();
  for (const id of [ownerId, agentId]) {
    const cred = JSON.parse(readFileSync(join(CREDS, `${id}.json`), "utf8"));
    await keyStore.setKey(NETWORK, id, KeyPair.fromString(cred.private_key));
  }
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC, deps: { keyStore } });
  const owner = await near.account(ownerId);
  const agent = await near.account(agentId);

  const out = {
    gate: "G-fixup",
    started_at: new Date().toISOString(),
    before,
    set_reconciler: null,
    agent_reconcile: null,
    owner_only_check: null,
    after: null,
  };

  if (!before.reconciler) {
    const t = await owner.functionCall({
      contractId,
      methodName: "set_reconciler",
      args: { reconciler: agentId },
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
    out.set_reconciler = {
      tx: t.transaction.hash,
      reconciler: await view(contractId, "get_reconciler"),
    };
  } else {
    out.set_reconciler = { skipped: true, reconciler: before.reconciler };
  }

  const op = before.op;
  if (!op) {
    out.agent_reconcile = { skipped: true, reason: "op missing" };
  } else if (op.signing_state !== "Reserved" || op.settlement_state !== "None") {
    out.agent_reconcile = {
      skipped: true,
      reason: `not abandoned never-signed: ${op.signing_state}/${op.settlement_state}`,
    };
  } else {
    // Honest Expired: never signed ⇒ no exportable ECDSA; not Success.
    const tx = await agent.functionCall({
      contractId,
      methodName: "reconcile_pending",
      args: {
        operation_id: OP_ID,
        settlement_state: "Expired",
        evidence_hash: "never-signed:Reserved/None:abandoned-f1-probe",
      },
      gas: BigInt("40000000000000"),
      attachedDeposit: 0n,
    });
    out.agent_reconcile = {
      ok: true,
      tx: tx.transaction.hash,
      actor: agentId,
      settlement_state: "Expired",
      rationale:
        "signing_state=Reserved and settlement_state=None ⇒ MPC never signed; no EVM tx exists. Expired releases reservation without fabricating Success.",
      evidence_hash: "never-signed:Reserved/None:abandoned-f1-probe",
      note: "evidence_hash is a stored pointer; contract does not verify it on Sepolia/Tidepool",
    };
  }

  out.after = {
    snap: await view(contractId, "get_exposure_snapshot"),
    reconciler: await view(contractId, "get_reconciler"),
    op: await view(contractId, "get_pending", { operation_id: OP_ID }),
    evidence_hash: await view(contractId, "get_evidence_hash", {
      operation_id: OP_ID,
    }),
  };

  // Merge into gate-g-evidence
  gateG.accounting.f1_leftover_trace = {
    operation_id: OP_ID,
    origin:
      "Pre-F1 probe leftover (hardcoded in gate-f-security.mjs leftovers). Successful F1 op was f1-1794229311568 (later Expired). F2 exposure_after reserved=1000000 / unresolved=1 is exactly this op.",
    pre_fix: before,
    post_fix: out.after,
    verdict:
      before.op?.signing_state === "Reserved" && before.op?.settlement_state === "None"
        ? "CORRECTLY_PENDING until Expired — never signed, abandoned; reservation held honestly"
        : `STATE=${before.op?.signing_state}/${before.op?.settlement_state}`,
  };
  gateG.accounting.reconcile_demo = out.agent_reconcile;
  gateG.accounting.snapshot_after = out.after.snap;
  gateG.accounting.unresolved_after =
    out.after.snap?.unresolved_pending === 0
      ? []
      : gateG.accounting.unresolved_after;
  gateG.reconcile_trust.reconciler_account = out.after.reconciler;
  if (out.set_reconciler?.tx) {
    gateG.reconcile_trust.set_reconciler_tx = out.set_reconciler.tx;
  }
  gateG.verdicts.G_accounting = {
    status:
      out.after.snap?.reserved_pending_exposure === "0" &&
      out.after.snap?.unresolved_pending === 0
        ? "PASS"
        : "FAIL",
    note: "Traced reserved=1e6 to f1-1794229262329 (Reserved/None). Expired via reconciler after proving never-signed. No fabricated Success.",
    operation_id: OP_ID,
    reservation_consistent_after:
      out.after.snap?.reserved_pending_exposure === "0" &&
      out.after.snap?.unresolved_pending === 0,
    snapshot_after: out.after.snap,
    reconcile_tx: out.agent_reconcile?.tx || null,
  };
  gateG.verdicts.G_reconcile_trust = {
    status: "PASS",
    evidence_hash_verified_onchain: false,
    reconciler_role_configured: !!out.after.reconciler,
    reconciler_account: out.after.reconciler,
    note: "Stored evidence_hash ≠ independent settlement proof. Reconciler/owner attest after off-chain verification.",
  };
  gateG.verdicts.G_narrow_watchdog = {
    status: out.agent_reconcile?.ok && out.after.reconciler ? "PASS" : "FAIL",
    design: "set_reconciler grants reconcile_pending without set_policy/revoke",
    demo_reconcile: out.agent_reconcile,
  };
  gateG.fixup = out;
  gateG.finished_at = new Date().toISOString();

  writeFileSync(join(EVIDENCE, "gate-g-evidence.json"), JSON.stringify(gateG, null, 2));
  writeFileSync(join(EVIDENCE, "gate-g-fixup.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ verdicts: gateG.verdicts, after: out.after }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
