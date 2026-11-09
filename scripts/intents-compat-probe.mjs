#!/usr/bin/env node
/**
 * Isolated Gate: can a Chain-Signatures secp256k1 signature authorize a NEAR Intents payload?
 * Does NOT assume compatibility. Records what formats exist and what blockers are observed.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const RPC = "https://rpc.testnet.near.org";
const MAINNET_RPC = "https://rpc.mainnet.near.org";
const out = {
  started_at: new Date().toISOString(),
  assumption: "NONE — probing only",
  findings: [],
  status: "BLOCKED",
};

async function view(rpc, accountId, methodName, args = {}) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "probe",
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
  const json = await res.json();
  if (json.error) return { error: json.error };
  const raw = Buffer.from(json.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// 1. Confirm our live signature curve
const ecdsa = existsSync("evidence/live/19-ecdsa-verify.json")
  ? JSON.parse(readFileSync("evidence/live/19-ecdsa-verify.json", "utf8"))
  : null;
const gateb = JSON.parse(readFileSync("evidence/live/gate-b-evidence.json", "utf8"));

out.findings.push({
  id: "curve",
  note: "Gate B produced Secp256k1 signature via domain_id=0 under contract-owned path",
  signature_scheme: gateb.steps?.signature_from_receipts?.signature_json?.scheme,
  derived_key: gateb.steps?.derived_public_key?.result,
  ecdsa_verified: ecdsa?.verified ?? null,
});

// 2. Probe intents.near (mainnet) for public key registration model
const intentsAccount = "intents.near";
let intentsCodeHash = null;
try {
  const res = await fetch(MAINNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "query",
      params: {
        request_type: "view_account",
        finality: "final",
        account_id: intentsAccount,
      },
    }),
  });
  const json = await res.json();
  intentsCodeHash = json.result?.code_hash ?? null;
  out.findings.push({
    id: "intents_near_exists",
    account: intentsAccount,
    code_hash: intentsCodeHash,
    amount: json.result?.amount,
  });
} catch (e) {
  out.findings.push({ id: "intents_near_exists", error: String(e) });
}

// 3. Check whether testnet has an intents verifier
for (const id of ["intents.testnet", "intents.near"]) {
  try {
    const res = await fetch(id.endsWith("testnet") ? RPC : MAINNET_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "query",
        params: {
          request_type: "view_account",
          finality: "final",
          account_id: id,
        },
      }),
    });
    const json = await res.json();
    out.findings.push({
      id: `account_${id}`,
      exists: !!json.result?.amount,
      code_hash: json.result?.code_hash,
      error: json.error || null,
    });
  } catch (e) {
    out.findings.push({ id: `account_${id}`, error: String(e) });
  }
}

// 4. Compatibility hypothesis (not proven)
out.findings.push({
  id: "compatibility_hypothesis",
  claim:
    "NEAR Intents named-account flow typically registers an ed25519/secp256k1 public key on intents.near and verifies signed intent payloads (NEP-413-like / intent-specific digest), NOT raw Chain-Signatures SignRequest hashes.",
  blockers_observed: [
    "Gate B signed an opaque 32-byte payload_commitment chosen by our policy contract, not an intents.near canonical intent digest.",
    "No live execute_intents / add_public_key call was attempted in this probe (isolation + no mainnet funds).",
    "Derived key is secp256k1 under contract predecessor+path; intents may require that exact key to be registered to a NEAR account / intent identity first.",
  ],
  next_experiment: [
    "Build the exact intents signed-payload bytes for a tiny testnet-compatible verifier (or Tidepool sandbox).",
    "Have the policy contract hash THAT payload (not a free-form commitment) before calling MPC.",
    "Attempt add_public_key with the derived secp256k1 key on the intents verifier, then submit one intent.",
  ],
});

out.status = "BLOCKED";
out.reason =
  "Chain Signature succeeded, but direct intents.near authorization is unproven. Payload semantics differ; no registration/settlement attempt performed. Do not claim Intent compatibility yet.";
out.finished_at = new Date().toISOString();

writeFileSync("evidence/live/20-intents-compat-probe.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
