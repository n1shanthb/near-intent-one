#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = join(ROOT, "evidence", "live");
const RPC = "https://test.rpc.fastnear.com";
const OP_ID = "f1-1794229262329";
const TX = "9MeJmCE5b1nzcdK6fMMft8vMx6Nx5GizYYWQZDDDzqUE";

async function rpc(method, params) {
  const j = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
  return j;
}

async function view(accountId, method, args = {}, finality = "optimistic") {
  const j = await rpc("query", {
    request_type: "call_function",
    finality,
    account_id: accountId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
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
  const contractId = gateC.accounts.contract.account_id;
  const agentId = gateC.accounts.agent.account_id;

  await new Promise((r) => setTimeout(r, 3000));

  const txStatus = await rpc("tx", [TX, agentId]);
  const status = txStatus.result?.status;
  const logs = (txStatus.result?.receipts_outcome || []).flatMap((o) => o.outcome?.logs || []);

  const snapOpt = await view(contractId, "get_exposure_snapshot", {}, "optimistic");
  const snapFin = await view(contractId, "get_exposure_snapshot", {}, "final");
  const opOpt = await view(contractId, "get_pending", { operation_id: OP_ID }, "optimistic");
  const opFin = await view(contractId, "get_pending", { operation_id: OP_ID }, "final");
  const ev = await view(contractId, "get_evidence_hash", { operation_id: OP_ID }, "optimistic");
  const pending = await view(contractId, "list_pending", {}, "optimistic");
  const unresolved = (pending || []).filter(
    (o) =>
      !["Success", "Refunded", "Failed", "Expired", "Reconciled"].includes(o.settlement_state) &&
      o.signing_state !== "RolledBack"
  );

  const out = {
    tx: TX,
    status,
    logs,
    snapOpt,
    snapFin,
    opOpt,
    opFin,
    evidence_hash: ev,
    unresolved: unresolved.map((o) => ({
      id: o.operation_id,
      signing: o.signing_state,
      settlement: o.settlement_state,
      amount: o.amount_in,
      evidence: o.evidence_hash,
    })),
  };
  writeFileSync(join(EVIDENCE, "gate-g-verify-state.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
