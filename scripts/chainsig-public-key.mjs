#!/usr/bin/env node
/**
 * Query the live MPC signer public key. Never hardcode.
 * Default: v1.signer-prod.testnet
 */
const SIGNER = process.env.MPC_SIGNER_ACCOUNT || "v1.signer-prod.testnet";
const RPC = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";

async function view(method, args = {}) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "chainsig-pk",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: SIGNER,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  const raw = Buffer.from(json.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^"|"$/g, "");
  }
}

const pk = await view("public_key");
console.log(JSON.stringify({ signer: SIGNER, public_key: pk }, null, 2));
