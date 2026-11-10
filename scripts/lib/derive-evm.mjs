import { evmAddressFromNearSecpKey } from "../../packages/intents-codec/eip191.mjs";

const MPC = process.env.MPC_SIGNER_ACCOUNT || "v1.signer-prod.testnet";
const RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";

async function view(accountId, methodName, args = {}) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "derive",
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
  if (json.error) throw new Error(JSON.stringify(json.error));
  const raw = Buffer.from(json.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^"|"$/g, "");
  }
}

/**
 * Derive Sepolia/Intents EVM address for a Chain Signatures path.
 * predecessor MUST be the policy contract account (MPC epsilon input).
 */
export async function deriveEvmAddressFromPath(path, predecessor) {
  if (!predecessor) {
    throw new Error("deriveEvmAddressFromPath requires predecessor (policy contract id)");
  }
  let key = await view(MPC, "derived_public_key", {
    path,
    predecessor,
    domain_id: 0,
  });
  if (typeof key === "object" && key !== null) {
    key = key.public_key || key;
  }
  if (typeof key !== "string") {
    throw new Error(`unexpected derived_public_key: ${JSON.stringify(key)}`);
  }
  return {
    near_secp_key: key,
    evm: evmAddressFromNearSecpKey(key).toLowerCase(),
    path,
    predecessor,
  };
}
