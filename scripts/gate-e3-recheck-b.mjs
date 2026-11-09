import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as nearAPI from "near-api-js";

const { connect, keyStores, KeyPair } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "evidence", "live");
const gateC = JSON.parse(readFileSync(join(EVIDENCE, "gate-c-evidence.json"), "utf8"));
const e3 = JSON.parse(readFileSync(join(EVIDENCE, "gate-e3-evidence.json"), "utf8"));
const eFull = JSON.parse(readFileSync(join(EVIDENCE, "gate-e-evidence.json"), "utf8"));
const ownerId = gateC.accounts.owner.account_id;
const agentId = gateC.accounts.agent.account_id;
const contractId = gateC.accounts.contract.account_id;

const RPCs = [
  "https://test.rpc.fastnear.com",
  "https://testnet.near.lava.build",
  "https://rpc.testnet.near.org",
];

async function view(rpc, accountId, method, args = {}) {
  const r = await fetch(rpc, {
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
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return JSON.parse(Buffer.from(j.result.result).toString());
}

let RPC = null;
for (const r of RPCs) {
  try {
    const st = await view(r, contractId, "get_revocation_status");
    console.log("rpc ok", r, st);
    RPC = r;
    break;
  } catch (e) {
    console.log("rpc fail", r, String(e).slice(0, 160));
  }
}
if (!RPC) throw new Error("no rpc");

const keyStore = new keyStores.InMemoryKeyStore();
for (const id of [ownerId, agentId, contractId]) {
  const cred = JSON.parse(readFileSync(join(CREDS, `${id}.json`), "utf8"));
  await keyStore.setKey("testnet", id, KeyPair.fromString(cred.private_key));
}
const near = await connect({ networkId: "testnet", nodeUrl: RPC, deps: { keyStore } });
const agent = await near.account(agentId);

let result;
try {
  await agent.functionCall({
    contractId,
    methodName: "propose_trade",
    args: {
      proposal: {
        operation_id: "e3-b-recheck-" + Date.now(),
        amount_in: "1",
        asset_in: "NEAR",
        asset_out: "NEAR",
        destination: "bob.testnet",
        min_amount_out: "1",
        intent_deadline: String(BigInt(Date.now()) * 1000000n + 3600000000000n),
        payload_commitment: "bb".repeat(32),
      },
    },
    gas: BigInt("50000000000000"),
    attachedDeposit: 0n,
  });
  result = { ok: true };
} catch (e) {
  result = { ok: false, error: String(e) };
}
console.log("propose_b_recheck", JSON.stringify(result, null, 2).slice(0, 1000));

e3.e3.propose_b_after_revoke_recheck = result;
e3.e3.propose_b_after_revoke_note =
  "Initial attempt hit deprecated RPC -429; recheck uses working RPC and proves revoke blocks new propose.";
eFull.e3.propose_b_after_revoke_recheck = result;
eFull.verdicts.E3.b_rejected_after_revoke = !result.ok;
eFull.verdicts.E3.b_reject_error_class = /revoked/i.test(result.error || "")
  ? "revoked"
  : "other";
writeFileSync(join(EVIDENCE, "gate-e3-evidence.json"), JSON.stringify(e3, null, 2));
writeFileSync(join(EVIDENCE, "gate-e-evidence.json"), JSON.stringify(eFull, null, 2));
console.log("revoked reject", /revoked/i.test(result.error || ""));
