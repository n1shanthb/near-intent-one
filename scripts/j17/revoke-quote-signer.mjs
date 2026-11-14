#!/usr/bin/env node
/**
 * J17.3 — Separately owner-authorized post-test quote signer revocation.
 *
 * Cleanup method (confirmed in contracts/policy): remove_trusted_quote_signer(public_key)
 * Requires J17_QUOTE_SIGNER_REVOKE_AUTHORIZED=1.
 * Never auto-run from broadcast.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as nearAPI from "near-api-js";
import { NETWORK, pickRpc, assertNotDemo } from "../lib/near-live.mjs";
import {
  AUTH_QUOTE_SIGNER_REVOKE,
  EXPECTED_ATTESTOR_PK,
  J16_POLICY,
  J16_OWNER,
  ATTESTOR_REVOCATION_PLAN,
  requireQuoteSignerRevokeAuth,
} from "../../packages/autonomous/j17.sepoliaPath.mjs";

const { connect, keyStores, KeyPair } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const report = {
  kind: "J17_QUOTE_SIGNER_REVOKE",
  started_at: new Date().toISOString(),
  network: NETWORK,
  policy: J16_POLICY,
  actor: J16_OWNER,
  public_key: EXPECTED_ATTESTOR_PK,
  method: "remove_trusted_quote_signer",
  revocation_plan: ATTESTOR_REVOCATION_PLAN,
  never_auto_from_broadcast: true,
};

function finish(code = 0) {
  report.finished_at = new Date().toISOString();
  const out = join(EVIDENCE, "J17_QUOTE_SIGNER_REVOKE.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence: out }, null, 2));
  process.exit(code);
}

async function nearView(rpc, accountId, methodName, args = {}) {
  const res = await fetch(rpc, {
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
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) {
    throw new Error(JSON.stringify(j.error || j.result.error));
  }
  const raw = Buffer.from(j.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const gate = requireQuoteSignerRevokeAuth();
report.authorization = { env: AUTH_QUOTE_SIGNER_REVOKE, gate };
if (!gate.ok) {
  report.ok = false;
  report.action = "REFUSED";
  report.reason = gate.reason;
  report.planned_call = {
    contract: J16_POLICY,
    method: "remove_trusted_quote_signer",
    args: { public_key: EXPECTED_ATTESTOR_PK },
    actor: J16_OWNER,
  };
  finish(0);
}

try {
  assertNotDemo();
  if (NETWORK !== "testnet") {
    report.ok = false;
    report.reason = "testnet_only";
    finish(1);
  }

  const nearRpc = await pickRpc();
  const ownerOnChain = await nearView(nearRpc, J16_POLICY, "get_owner");
  if (String(ownerOnChain) !== J16_OWNER) {
    report.ok = false;
    report.reason = "owner_mismatch";
    report.observed_owner = ownerOnChain;
    finish(1);
  }

  const before = await nearView(nearRpc, J16_POLICY, "is_trusted_quote_signer", {
    public_key: EXPECTED_ATTESTOR_PK,
  });
  report.before_trusted = before === true;
  if (before !== true) {
    report.ok = true;
    report.action = "ALREADY_REMOVED";
    report.verified = true;
    finish(0);
  }

  const cred = JSON.parse(readFileSync(join(CREDS, `${J16_OWNER}.json`), "utf8"));
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey(NETWORK, J16_OWNER, KeyPair.fromString(cred.private_key));
  const near = await connect({
    networkId: NETWORK,
    nodeUrl: nearRpc,
    deps: { keyStore: ks },
  });
  const owner = await near.account(J16_OWNER);
  const outcome = await owner.functionCall({
    contractId: J16_POLICY,
    methodName: "remove_trusted_quote_signer",
    args: { public_key: EXPECTED_ATTESTOR_PK },
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });
  if (outcome.status?.Failure) {
    throw new Error(JSON.stringify(outcome.status.Failure));
  }
  report.near_tx = outcome.transaction.hash;
  report.explorer = `https://testnet.nearblocks.io/txns/${outcome.transaction.hash}`;

  const after = await nearView(nearRpc, J16_POLICY, "is_trusted_quote_signer", {
    public_key: EXPECTED_ATTESTOR_PK,
  });
  report.independent_verify = {
    method: "is_trusted_quote_signer",
    public_key: EXPECTED_ATTESTOR_PK,
    result: after === false,
  };
  report.ok = after === false;
  report.action = after === false ? "REVOKED" : "REVOKE_UNVERIFIED";
  finish(after === false ? 0 : 1);
} catch (e) {
  report.ok = false;
  report.action = "FAILED";
  report.error = String(e.message || e).slice(0, 800);
  finish(1);
}
