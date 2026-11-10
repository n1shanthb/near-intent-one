#!/usr/bin/env node
/**
 * Upgrade Gate I policy contracts with get_gate_j_mandate views (code only, no state wipe).
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pickRpc,
  connectWithAccounts,
  viewFunction,
  assertNotDemo,
} from "./lib/near-live.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const WASM = join(
  ROOT,
  "contracts/policy/target/wasm32-unknown-unknown/release/policy.wasm"
);

/** Policy account → local FullAccess key holder (owner). */
const POLICIES = [
  {
    policy: "policy.nio-i-a4e7-a-owner.testnet",
    signerCred: "nio-i-a4e7-a-owner.testnet",
  },
  {
    policy: "policy.owner.nio-i-a4e7-agent.testnet",
    signerCred: "owner.nio-i-a4e7-agent.testnet",
  },
];

async function main() {
  if (!existsSync(WASM)) throw new Error("missing policy.wasm — build first");
  const wasm = readFileSync(WASM);
  const rpc = await pickRpc();
  const { connect, keyStores, KeyPair } = await import("near-api-js");
  const { loadCred } = await import("./lib/near-live.mjs");
  const keyStore = new keyStores.InMemoryKeyStore();
  for (const row of POLICIES) {
    const c = loadCred(CREDS, row.signerCred);
    await keyStore.setKey(
      "testnet",
      row.policy,
      KeyPair.fromString(c.private_key)
    );
  }
  const near = await connect({
    networkId: "testnet",
    nodeUrl: rpc,
    deps: { keyStore },
  });
  const out = { at: new Date().toISOString(), wasm_bytes: wasm.length, upgrades: {} };

  for (const row of POLICIES) {
    const id = row.policy;
    assertNotDemo(id);
    const account = await near.account(id);
    const res = await account.deployContract(wasm);
    let mandate = null;
    try {
      mandate = await viewFunction(rpc, id, "get_gate_j_mandate", {});
    } catch (e) {
      mandate = { error: String(e.message || e).slice(0, 200) };
    }
    out.upgrades[id] = {
      tx: res.transaction.hash,
      mandate_ok: !mandate?.error,
      portfolio_id: mandate?.portfolio_id,
      paused: mandate?.paused,
      revoked: mandate?.revoked,
      policy_hash: mandate?.policy_hash,
      mandate_epoch: mandate?.mandate_epoch,
    };
    console.log(id, out.upgrades[id].tx, out.upgrades[id].mandate_ok);
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
