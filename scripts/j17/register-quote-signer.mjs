#!/usr/bin/env node
/**
 * J17.3 — Owner-authorized testnet-only trusted quote signer registration.
 *
 * Requires J17_QUOTE_SIGNER_REGISTER_AUTHORIZED=1.
 * Never invoked automatically by broadcast / MPC scripts.
 *
 * Verifies: network=testnet, policy id, owner actor, expected ed25519 pk,
 * then set_trusted_quote_signer and independently checks is_trusted_quote_signer.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as nearAPI from "near-api-js";
import { NETWORK, pickRpc, assertNotDemo } from "../lib/near-live.mjs";
import {
  AUTH_QUOTE_SIGNER_REGISTER,
  EXPECTED_ATTESTOR_PK,
  J16_POLICY,
  J16_OWNER,
  requireQuoteSignerRegisterAuth,
} from "../../packages/autonomous/j17.sepoliaPath.mjs";

const { connect, keyStores, KeyPair } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const report = {
  kind: "J17_QUOTE_SIGNER_REGISTER",
  started_at: new Date().toISOString(),
  network: NETWORK,
  policy: J16_POLICY,
  actor: J16_OWNER,
  public_key: EXPECTED_ATTESTOR_PK,
  method: "set_trusted_quote_signer",
  never_auto_from_broadcast: true,
};

function finish(code = 0) {
  report.finished_at = new Date().toISOString();
  const out = join(EVIDENCE, "J17_QUOTE_SIGNER_REGISTER.json");
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

const gate = requireQuoteSignerRegisterAuth();
report.authorization = { env: AUTH_QUOTE_SIGNER_REGISTER, gate };
if (!gate.ok) {
  report.ok = false;
  report.action = "REFUSED";
  report.reason = gate.reason;
  report.planned_call = {
    contract: J16_POLICY,
    method: "set_trusted_quote_signer",
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

  const already = await nearView(nearRpc, J16_POLICY, "is_trusted_quote_signer", {
    public_key: EXPECTED_ATTESTOR_PK,
  });
  if (already === true) {
    report.ok = true;
    report.action = "ALREADY_TRUSTED";
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
    methodName: "set_trusted_quote_signer",
    args: { public_key: EXPECTED_ATTESTOR_PK },
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });
  if (outcome.status?.Failure) {
    throw new Error(JSON.stringify(outcome.status.Failure));
  }
  report.near_tx = outcome.transaction.hash;
  report.explorer = `https://testnet.nearblocks.io/txns/${outcome.transaction.hash}`;

  const trusted = await nearView(nearRpc, J16_POLICY, "is_trusted_quote_signer", {
    public_key: EXPECTED_ATTESTOR_PK,
  });
  report.independent_verify = {
    method: "is_trusted_quote_signer",
    public_key: EXPECTED_ATTESTOR_PK,
    result: trusted === true,
  };
  report.ok = trusted === true;
  report.action = trusted === true ? "REGISTERED" : "REGISTER_UNVERIFIED";
  finish(trusted === true ? 0 : 1);
} catch (e) {
  report.ok = false;
  report.action = "FAILED";
  report.error = String(e.message || e).slice(0, 800);
  finish(1);
}
