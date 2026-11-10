import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as nearAPI from "near-api-js";

const { connect, keyStores, KeyPair } = nearAPI;

export const NETWORK = "testnet";
export const RPCS = [
  process.env.NEAR_RPC,
  "https://test.rpc.fastnear.com",
  "https://rpc.testnet.near.org",
].filter(Boolean);
export const MPC = "v1.signer-prod.testnet";
export const VERIFIER = "verifier.tidepool-sandbox.testnet";
export const DEMO_PREFIX = "nio-c-";
export const SEPOLIA_RPC =
  process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
export const USDC_SEPOLIA = "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2";
export const ORIGIN_ASSET =
  "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet";
export const DEST_ASSET = "nep141:wnear.tidepool-sandbox.testnet";
export const TIDEPOOL = process.env.TIDEPOOL_URL || "https://www.usetidepool.tech";

export function assertNotDemo(id) {
  if (String(id).startsWith(DEMO_PREFIX)) {
    throw new Error(`refusing to touch demo account ${id}`);
  }
}

export async function pickRpc() {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "status",
          params: [],
        }),
      });
      const j = await r.json();
      if (j.result || !j.error) return url;
    } catch {
      /* next */
    }
  }
  return RPCS[0];
}

export async function nearRpc(rpc, method, params) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "nio", method, params }),
  });
  return res.json();
}

export async function viewFunction(rpc, accountId, methodName, args = {}) {
  const json = await nearRpc(rpc, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (json.error) throw new Error(JSON.stringify(json.error));
  if (json.result?.error) throw new Error(String(json.result.error));
  if (!json.result?.result) return null;
  const raw = Buffer.from(json.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^"|"$/g, "");
  }
}

export function loadCred(credsDir, accountId) {
  assertNotDemo(accountId);
  const path = join(credsDir, `${accountId}.json`);
  if (!existsSync(path)) throw new Error(`missing cred ${accountId}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function connectWithAccounts(rpc, credsDir, accountIds) {
  const keyStore = new keyStores.InMemoryKeyStore();
  for (const id of accountIds) {
    assertNotDemo(id);
    const c = loadCred(credsDir, id);
    await keyStore.setKey(NETWORK, id, KeyPair.fromString(c.private_key));
  }
  const near = await connect({
    networkId: NETWORK,
    nodeUrl: rpc,
    deps: { keyStore },
  });
  return near;
}

export async function eth(method, params) {
  const res = await fetch(SEPOLIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

export async function erc20Balance(token, holder) {
  const data =
    "0x70a08231" + holder.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const res = await eth("eth_call", [{ to: token, data }, "latest"]);
  if (!res.result || res.result === "0x") return "0";
  return BigInt(res.result).toString();
}

export async function ethBalance(addr) {
  const res = await eth("eth_getBalance", [addr, "latest"]);
  return BigInt(res.result || "0").toString();
}

export async function intentsMtBalance(rpc, accountId, tokenId = ORIGIN_ASSET) {
  try {
    return String(
      await viewFunction(rpc, VERIFIER, "mt_balance_of", {
        account_id: accountId,
        token_id: tokenId,
      })
    );
  } catch (e) {
    return { error: String(e.message || e) };
  }
}
