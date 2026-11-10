#!/usr/bin/env node
/**
 * Gate I1 — provision TWO independent testnet portfolios.
 * Does NOT touch nio-c-* Ledger demo accounts.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as nearAPI from "near-api-js";
import { deriveEvmAddressFromPath } from "./lib/derive-evm.mjs";
import {
  assertNotDemo,
  DEMO_PREFIX,
  MPC,
  NETWORK,
  ORIGIN_ASSET,
  DEST_ASSET,
  VERIFIER,
  pickRpc,
} from "./lib/near-live.mjs";

const { connect, keyStores, KeyPair } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "evidence", "live");
const FAUCETS = [
  "https://helper.nearprotocol.com/account",
  "https://helper.testnet.near.org/account",
];

mkdirSync(CREDS, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

async function faucetCreate(accountId, publicKey) {
  assertNotDemo(accountId);
  for (const url of FAUCETS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
      });
      if (res.ok) return { ok: true, faucet: url };
      const text = await res.text().catch(() => "");
      if (text.includes("already exists") || text.includes("AlreadyExists")) {
        return { ok: true, faucet: url, existed: true };
      }
    } catch {
      /* next */
    }
  }
  return { ok: false };
}

function saveCred(accountId, role, kp) {
  assertNotDemo(accountId);
  const path = join(CREDS, `${accountId}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        account_id: accountId,
        public_key: kp.getPublicKey().toString(),
        private_key: kp.toString(),
        role,
        gate: "I",
      },
      null,
      2
    )
  );
  return path;
}

async function accountExists(rpc, accountId) {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "query",
        params: {
          request_type: "view_account",
          finality: "final",
          account_id: accountId,
        },
      }),
    });
    const j = await res.json();
    return !!j.result;
  } catch {
    return false;
  }
}

async function ensureAccount(tag, role, { rpc, sponsor } = {}) {
  const nodeUrl = rpc || (await pickRpc());
  // Prefer existing sponsor subaccount if already provisioned
  if (sponsor) {
    const subId = `${role}.${sponsor.account_id}`;
    const subPath = join(CREDS, `${subId}.json`);
    if (existsSync(subPath) && (await accountExists(nodeUrl, subId))) {
      return JSON.parse(readFileSync(subPath, "utf8"));
    }
    if (await accountExists(nodeUrl, subId)) {
      // recover key from top-level stub if present
      const top = `nio-i-${tag}-${role}.testnet`;
      const topPath = join(CREDS, `${top}.json`);
      if (!existsSync(topPath)) throw new Error(`missing key material for ${subId}`);
      const cred = JSON.parse(readFileSync(topPath, "utf8"));
      const subCred = {
        account_id: subId,
        public_key: cred.public_key,
        private_key: cred.private_key,
        role,
        gate: "I",
        parent: sponsor.account_id,
      };
      writeFileSync(subPath, JSON.stringify(subCred, null, 2));
      return subCred;
    }
  }

  const accountId = `nio-i-${tag}-${role}.testnet`;
  assertNotDemo(accountId);
  const path = join(CREDS, `${accountId}.json`);
  let cred;
  if (existsSync(path)) {
    cred = JSON.parse(readFileSync(path, "utf8"));
  } else {
    const kp = KeyPair.fromRandom("ed25519");
    saveCred(accountId, role, kp);
    cred = JSON.parse(readFileSync(path, "utf8"));
  }
  if (await accountExists(nodeUrl, accountId)) {
    return cred;
  }
  const created = await faucetCreate(accountId, cred.public_key);
  if (created.ok && (await accountExists(nodeUrl, accountId))) {
    return cred;
  }
  // Fallback: create subaccount under sponsor
  if (sponsor) {
    const subId = `${role}.${sponsor.account_id}`;
    assertNotDemo(subId);
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(
      NETWORK,
      sponsor.account_id,
      KeyPair.fromString(sponsor.private_key)
    );
    const near = await connect({
      networkId: NETWORK,
      nodeUrl,
      deps: { keyStore },
    });
    const sp = await near.account(sponsor.account_id);
    // pull NEAR from agent/recon if owner is lean — caller tops up separately
    await sp.createAccount(
      subId,
      cred.public_key,
      BigInt("3000000000000000000000000")
    );
    const subCred = {
      account_id: subId,
      public_key: cred.public_key,
      private_key: cred.private_key,
      role,
      gate: "I",
      parent: sponsor.account_id,
    };
    writeFileSync(join(CREDS, `${subId}.json`), JSON.stringify(subCred, null, 2));
    return subCred;
  }
  throw new Error(`faucet failed for ${accountId}`);
}

async function main() {
  if (DEMO_PREFIX !== "nio-c-") throw new Error("demo prefix guard broken");
  const suffix = process.env.GATE_I_SUFFIX || randomBytes(2).toString("hex");
  const rpc = await pickRpc();
  const wasmPath = join(
    ROOT,
    "contracts/policy/target/wasm32-unknown-unknown/release/policy.wasm"
  );
  if (!existsSync(wasmPath)) throw new Error("build policy.wasm first");
  const wasm = readFileSync(wasmPath);

  const agent = await ensureAccount(`${suffix}`, "agent", { rpc });
  const recon = await ensureAccount(`${suffix}`, "recon", { rpc });

  const users = [];
  for (const tag of ["a", "b"]) {
    // Owners prefer faucet; if rate-limited, sponsor under agent (still independent FullAccess keys)
    let owner = await ensureAccount(`${suffix}-${tag}`, "owner", {
      rpc,
      sponsor: tag === "b" ? agent : null,
    });
    if (tag === "b" && owner.account_id === `nio-i-${suffix}-b-owner.testnet`) {
      // force sponsor path if top-level still missing
      try {
        owner = await ensureAccount(`${suffix}-${tag}`, "owner", {
          rpc,
          sponsor: agent,
        });
      } catch {
        /* keep */
      }
    }
    // Policy as subaccount under that owner
    let policy = await ensureAccount(`${suffix}-${tag}`, "policy", {
      rpc,
      sponsor: owner,
    });
    const portfolioId = `i-${tag}-${suffix}`;
    assertNotDemo(owner.account_id);
    assertNotDemo(policy.account_id);

    const keyStore = new keyStores.InMemoryKeyStore();
    for (const c of [owner, policy, agent, recon]) {
      await keyStore.setKey(
        NETWORK,
        c.account_id,
        KeyPair.fromString(c.private_key)
      );
    }
    const near = await connect({ networkId: NETWORK, nodeUrl: rpc, deps: { keyStore } });
    const policyAcct = await near.account(policy.account_id);
    const ownerAcct = await near.account(owner.account_id);

    // Skip if already initialized (idempotent re-runs after policy software key deleted)
    let already = null;
    try {
      const st = await near.connection.provider.query({
        request_type: "call_function",
        finality: "final",
        account_id: policy.account_id,
        method_name: "get_intents_signer_id",
        args_base64: Buffer.from("{}").toString("base64"),
      });
      already = JSON.parse(Buffer.from(st.result).toString("utf8"));
    } catch {
      already = null;
    }
    if (already && String(already).startsWith("0x")) {
      const pathOnChain = JSON.parse(
        Buffer.from(
          (
            await near.connection.provider.query({
              request_type: "call_function",
              finality: "final",
              account_id: policy.account_id,
              method_name: "get_derivation_path",
              args_base64: Buffer.from("{}").toString("base64"),
            })
          ).result
        ).toString("utf8")
      );
      users.push({
        tag,
        portfolio_id: portfolioId,
        derivation_path: pathOnChain,
        derivation_path_on_chain: pathOnChain,
        evm: String(already).toLowerCase(),
        owner: owner.account_id,
        policy: policy.account_id,
        agent: agent.account_id,
        reconciler: recon.account_id,
        skipped_already_ready: true,
      });
      continue;
    }

    // Fund policy for wasm storage (contract code is large) from owner+agent
    async function topUp(fromId, fromKey, amount) {
      const ks = new keyStores.InMemoryKeyStore();
      await ks.setKey(NETWORK, fromId, KeyPair.fromString(fromKey));
      const n = await connect({ networkId: NETWORK, nodeUrl: rpc, deps: { keyStore: ks } });
      const a = await n.account(fromId);
      await a.sendMoney(policy.account_id, amount);
    }
    try {
      const st = await policyAcct.getAccountBalance();
      const avail = BigInt(st.available);
      if (avail < 6_000_000_000_000_000_000_000n) {
        const need = 7_000_000_000_000_000_000_000n - avail;
        try {
          await ownerAcct.sendMoney(policy.account_id, need / 2n + 1n);
        } catch {
          /* */
        }
        try {
          await topUp(agent.account_id, agent.private_key, need / 2n + 1n);
        } catch {
          /* */
        }
        try {
          await topUp(recon.account_id, recon.private_key, need / 2n + 1n);
        } catch {
          /* */
        }
      }
    } catch {
      /* best-effort */
    }

    // Prefer dedicated policy key; if deleted, sign as owner FullAccess on policy account
    let deployer = policyAcct;
    try {
      await near.connection.provider.query({
        request_type: "view_access_key",
        finality: "final",
        account_id: policy.account_id,
        public_key: policy.public_key,
      });
    } catch {
      await keyStore.setKey(
        NETWORK,
        policy.account_id,
        KeyPair.fromString(owner.private_key)
      );
      deployer = await near.account(policy.account_id);
    }
    const deploy = await deployer.deployContract(wasm);
    const path = `trading/v1/portfolio/${portfolioId}`;
    const limits = {
      max_trade_value: "100000000",
      daily_turnover_limit: "1000000000",
      max_pending_exposure: "100000000",
      max_slippage_bps: 100,
      allowed_assets: [ORIGIN_ASSET, DEST_ASSET, "USDC", "NEAR"],
      allowed_destinations: [owner.account_id],
      valid_until: "1893456000000000000",
    };

    let initTx = null;
    try {
      const init = await policyAcct.functionCall({
        contractId: policy.account_id,
        methodName: "new",
        args: {
          owner: owner.account_id,
          agent: agent.account_id,
          mpc_signer: MPC,
          portfolio_id: portfolioId,
          verifying_contract: VERIFIER,
          limits,
        },
        gas: BigInt("80000000000000"),
        attachedDeposit: 0n,
      });
      initTx = init.transaction.hash;
    } catch (e) {
      const msg = String(e.message || e);
      if (!msg.includes("already initialized") && !msg.includes("method not found")) {
        // rethrow unless already inited from prior partial run
        throw e;
      }
      initTx = `already-initialized:${msg.slice(0, 80)}`;
    }

    const derived = await deriveEvmAddressFromPath(path, policy.account_id);
    const evm = derived.evm;

    limits.allowed_destinations = [
      owner.account_id,
      evm.toLowerCase(),
    ];

    const setPolicy = await ownerAcct.functionCall({
      contractId: policy.account_id,
      methodName: "set_policy",
      args: {
        limits,
        policy_hash: `gate-i-${tag}-v1`,
        strategy_hash: "gate-i-lifecycle",
      },
      gas: BigInt("50000000000000"),
      attachedDeposit: 0n,
    });
    const setSigner = await ownerAcct.functionCall({
      contractId: policy.account_id,
      methodName: "set_intents_signer_id",
      args: { intents_signer_id: evm.toLowerCase() },
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
    const setRecon = await ownerAcct.functionCall({
      contractId: policy.account_id,
      methodName: "set_reconciler",
      args: { reconciler: recon.account_id },
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });

    // Upgrade isolation: owner FullAccess on policy; remove dedicated policy software key
    const ownerPk = owner.public_key;
    const keys = await near.connection.provider.query({
      request_type: "view_access_key_list",
      finality: "final",
      account_id: policy.account_id,
    });
    const hasOwner = (keys.keys || []).some((k) => k.public_key === ownerPk);
    if (!hasOwner) {
      await policyAcct.addKey(ownerPk);
    }
    let deletedPolicyKey = false;
    if (policy.public_key !== ownerPk) {
      try {
        await policyAcct.deleteKey(policy.public_key);
        deletedPolicyKey = true;
      } catch (e) {
        deletedPolicyKey = String(e.message || e);
      }
    }

    const onPath = await near.connection.provider.query({
      request_type: "call_function",
      finality: "final",
      account_id: policy.account_id,
      method_name: "get_derivation_path",
      args_base64: Buffer.from("{}").toString("base64"),
    });
    const pathOnChain = JSON.parse(
      Buffer.from(onPath.result).toString("utf8")
    );

    users.push({
      tag,
      portfolio_id: portfolioId,
      derivation_path: path,
      derivation_path_on_chain: pathOnChain,
      evm,
      near_secp_key: derived.near_secp_key,
      owner: owner.account_id,
      policy: policy.account_id,
      agent: agent.account_id,
      reconciler: recon.account_id,
      deploy_tx: deploy.transaction.hash,
      init_tx: initTx,
      set_policy_tx: setPolicy.transaction.hash,
      set_signer_tx: setSigner.transaction.hash,
      set_reconciler_tx: setRecon.transaction.hash,
      deleted_policy_software_key: deletedPolicyKey,
    });
  }

  const out = {
    gate: "I1-provision",
    network: NETWORK,
    rpc,
    suffix,
    note: "Independent portfolios; demo nio-c-* untouched",
    demo_untouched: true,
    agent: agent.account_id,
    reconciler: recon.account_id,
    users,
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(EVIDENCE, "gate-i-provision.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
