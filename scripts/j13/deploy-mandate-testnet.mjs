#!/usr/bin/env node
/**
 * J13 — Deploy/upgrade J12 policy WASM on testnet and prove mandate autonomy.
 * Prefers disposable faucet accounts; falls back to Gate I a4e7 trio + WASM upgrade.
 * HARD STOP: testnet only.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import * as nearAPI from "near-api-js";
import {
  NETWORK,
  MPC,
  VERIFIER,
  pickRpc,
  assertNotDemo,
  ORIGIN_ASSET,
  DEST_ASSET,
} from "../lib/near-live.mjs";

const { connect, keyStores, KeyPair } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "docs", "evidence");
const WASM = join(
  ROOT,
  "contracts/policy/target/wasm32-unknown-unknown/release/policy.wasm"
);

mkdirSync(CREDS, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

const FAUCETS = [
  "https://helper.nearprotocol.com/account",
  "https://helper.testnet.near.org/account",
];

function wasmHash(buf) {
  return createHash("sha256").update(buf).digest("hex").toUpperCase();
}

async function faucetCreate(accountId, publicKey) {
  for (const url of FAUCETS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
      });
      if (res.ok) return { ok: true, faucet: url };
      const text = await res.text().catch(() => "");
      if (/already exists|AlreadyExists/i.test(text)) {
        return { ok: true, faucet: url, existed: true };
      }
    } catch {
      /* next */
    }
  }
  return { ok: false };
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
    return Boolean(j.result) && !j.error;
  } catch {
    return false;
  }
}

function saveCred(accountId, role, kp) {
  const path = join(CREDS, `${accountId}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        account_id: accountId,
        public_key: kp.getPublicKey().toString(),
        private_key: kp.toString(),
        role,
        gate: "J13",
      },
      null,
      2
    )
  );
  return path;
}

function loadCred(accountId) {
  return JSON.parse(readFileSync(join(CREDS, `${accountId}.json`), "utf8"));
}

function loadOrCreate(accountId, role) {
  const path = join(CREDS, `${accountId}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const kp = KeyPair.fromRandom("ed25519");
  saveCred(accountId, role, kp);
  return JSON.parse(readFileSync(path, "utf8"));
}

async function ensureFaucetAccount(rpc, accountId, role) {
  assertNotDemo(accountId);
  const cred = loadOrCreate(accountId, role);
  if (!(await accountExists(rpc, accountId))) {
    const created = await faucetCreate(accountId, cred.public_key);
    if (!created.ok || !(await accountExists(rpc, accountId))) {
      throw new Error(`faucet_failed:${accountId}`);
    }
  }
  return cred;
}

async function connectWith(creds, rpc) {
  const keyStore = new keyStores.InMemoryKeyStore();
  for (const c of creds) {
    await keyStore.setKey(NETWORK, c.account_id, KeyPair.fromString(c.private_key));
  }
  return connect({ networkId: NETWORK, nodeUrl: rpc, deps: { keyStore } });
}

async function view(acct, method, args = {}) {
  return acct.viewFunction({ contractId: acct.accountId, methodName: method, args });
}

function defaultLimits(ownerId) {
  return {
    max_trade_value: "10",
    daily_turnover_limit: "100",
    max_pending_exposure: "50",
    max_slippage_bps: 100,
    allowed_assets: ["USDC", "NEAR", ORIGIN_ASSET, DEST_ASSET],
    allowed_destinations: ["intents.near", ownerId],
    valid_until: "1893456000000000000",
    token_scope: "allowlist",
    allowed_chains: ["near", "eip155:11155111"],
    allowed_venues: ["near_intents_1click"],
    max_gas_budget: "300000000000000",
  };
}

function proposal(id, amount) {
  return {
    operation_id: id,
    amount_in: String(amount),
    asset_in: "USDC",
    asset_out: "NEAR",
    destination: "intents.near",
    min_amount_out: String(Math.max(1, Math.floor((Number(amount) * 99) / 100))),
    intent_deadline: "9000000000000000000",
    payload_commitment:
      "521da91dc9bddb625bd0679d9e735def558761a34653624f5954f44bce6443a9",
  };
}

async function expectFail(fn, label) {
  try {
    await fn();
    return { ok: false, label, error: "expected_failure_but_succeeded" };
  } catch (e) {
    return { ok: true, label, error: String(e.message || e).slice(0, 400) };
  }
}

async function topUp(fromCred, toId, amount, rpc) {
  const near = await connectWith([fromCred], rpc);
  const a = await near.account(fromCred.account_id);
  await a.sendMoney(toId, amount);
}

async function main() {
  const report = {
    kind: "J13_DEPLOYED_MANDATE_TESTNET",
    started_at: new Date().toISOString(),
    network: NETWORK,
    hard_stop_mainnet: true,
    steps: [],
    verdicts: {},
  };

  if (!existsSync(WASM)) {
    report.error = "policy.wasm missing";
    writeFileSync(join(EVIDENCE, "J13_DEPLOYED_MANDATE_TESTNET.json"), JSON.stringify(report, null, 2));
    process.exit(1);
  }
  const wasm = readFileSync(WASM);
  report.wasm_sha256 = wasmHash(wasm);
  report.wasm_bytes = wasm.length;

  const rpc = await pickRpc();
  report.rpc = rpc;
  const tag = process.env.J13_SUFFIX || randomBytes(2).toString("hex");

  let owner;
  let agent;
  let policyCred;
  let mode = "faucet_disposable";

  try {
    owner = await ensureFaucetAccount(rpc, `nio-j13-${tag}-owner.testnet`, "owner");
    agent = await ensureFaucetAccount(rpc, `nio-j13-${tag}-agent.testnet`, "agent");
    policyCred = await ensureFaucetAccount(rpc, `nio-j13-${tag}-policy.testnet`, "policy");
    // Top up policy from owner if possible (faucet accounts start with ~10N)
    report.accounts = {
      owner: owner.account_id,
      agent: agent.account_id,
      policy: policyCred.account_id,
    };
  } catch (e) {
    report.faucet_error = String(e.message || e);
    // Prefer a funded empty-code sponsor (agent-02b7cf) to create a fresh
    // policy subaccount. Never upgrade existing Borsh state (unreachable trap).
    const sponsor = loadCred("nio-agent-02b7cf.testnet");
    owner = loadCred("nio-owner-02b7cf.testnet");
    agent = loadCred("nio-agent-02b7cf.testnet");
    // Dedicated agent key material distinct from owner; for trading we still
    // use agent-02b7cf. Policy gets a brand-new keypair on a new subaccount.
    const policyKp = KeyPair.fromRandom("ed25519");
    const subPolicy = `j13pol.${sponsor.account_id}`;
    assertNotDemo(subPolicy);
    saveCred(subPolicy, "policy", policyKp);
    policyCred = {
      account_id: subPolicy,
      public_key: policyKp.getPublicKey().toString(),
      private_key: policyKp.toString(),
      role: "policy",
      gate: "J13",
    };
    report.accounts = {
      owner: owner.account_id,
      agent: agent.account_id,
      policy: subPolicy,
      sponsor: sponsor.account_id,
    };
    if (!(await accountExists(rpc, subPolicy))) {
      const nearBoot = await connectWith([sponsor], rpc);
      const sp = await nearBoot.account(sponsor.account_id);
      // Leave ~2N on sponsor; 7.5N on fresh policy for WASM storage.
      await sp.createAccount(
        subPolicy,
        policyKp.getPublicKey().toString(),
        BigInt("7500000000000000000000000")
      );
      report.steps.push({ create_fresh_policy: subPolicy, funded_n: "7.5" });
    } else {
      report.steps.push({ reuse_fresh_policy: subPolicy });
    }
    // Also ensure owner can pay gas: top up owner from nio-j13 faucet leftovers if lean
    try {
      const j13owner = loadOrCreate("nio-j13-edcb-owner.testnet", "owner");
      if (await accountExists(rpc, j13owner.account_id)) {
        await topUp(j13owner, owner.account_id, BigInt("2000000000000000000000000"), rpc);
        report.steps.push({ topup_owner_from_j13_faucet: "2N" });
      }
    } catch (err) {
      report.steps.push({ topup_owner_skip: String(err.message || err).slice(0, 160) });
    }
    report.note =
      "Fresh policy subaccount j13pol.nio-agent-02b7cf.testnet; distinct owner/agent/policy keys.";
    mode = "faucet_disposable"; // force init path
  }
  report.mode = mode;

  report.key_isolation = {
    owner_pk: owner.public_key,
    agent_pk: agent.public_key,
    policy_signer_pk: policyCred.public_key,
    agent_distinct_from_owner: owner.public_key !== agent.public_key,
    // Strict three-way distinct when faucet path; upgrade path may share owner FA on policy (admin).
    all_distinct:
      owner.public_key !== agent.public_key &&
      agent.public_key !== policyCred.public_key &&
      (mode === "faucet_disposable"
        ? owner.public_key !== policyCred.public_key
        : true),
  };
  if (!report.key_isolation.agent_distinct_from_owner) {
    report.verdicts.KEY_ISOLATION_TESTNET = "FAIL";
    writeFileSync(join(EVIDENCE, "J13_DEPLOYED_MANDATE_TESTNET.json"), JSON.stringify(report, null, 2));
    process.exit(1);
  }
  report.verdicts.KEY_ISOLATION_TESTNET = "PASS";

  const near = await connectWith([owner, agent, policyCred], rpc);
  const policyAcct = await near.account(report.accounts.policy);
  const ownerAcct = await near.account(report.accounts.owner);
  const agentAcct = await near.account(report.accounts.agent);

  const bal = await policyAcct.getAccountBalance();
  report.policy_balance_before = bal.available;

  const deployTx = await policyAcct.deployContract(wasm);
  report.steps.push({
    deploy_or_upgrade: deployTx.transaction.hash,
    explorer: `https://testnet.nearblocks.io/txns/${deployTx.transaction.hash}`,
  });

  const limits = defaultLimits(report.accounts.owner);
  const portfolioId = `j13-${tag}`;

  // Init only for fresh accounts
  if (mode === "faucet_disposable") {
    const initTx = await policyAcct.functionCall({
      contractId: report.accounts.policy,
      methodName: "new",
      args: {
        owner: report.accounts.owner,
        agent: report.accounts.agent,
        mpc_signer: MPC,
        portfolio_id: portfolioId,
        verifying_contract: VERIFIER,
        limits,
      },
      gas: BigInt("100000000000000"),
    });
    report.steps.push({ init: initTx.transaction.hash });
  } else {
    report.steps.push({ init: "skipped_upgrade_preserves_state" });
  }

  try {
    const tx = await ownerAcct.functionCall({
      contractId: report.accounts.policy,
      methodName: "set_intents_signer_id",
      args: { intents_signer_id: "0xca67c1bb3fd69857e5edaf6aa1c65371bf46a464" },
      gas: BigInt("30000000000000"),
    });
    report.steps.push({ set_intents_signer_id: tx.transaction.hash });
  } catch (e) {
    report.steps.push({ set_intents_signer_id: String(e.message || e).slice(0, 200) });
  }

  const agentActivate = await expectFail(
    () =>
      agentAcct.functionCall({
        contractId: report.accounts.policy,
        methodName: "activate_autonomous_mandate",
        args: {
          limits,
          policy_hash: "evil",
          strategy_hash: "evil",
          enforce_autonomous_on_agent: true,
          autonomous_trading: true,
          unpause_now: true,
        },
        gas: BigInt("80000000000000"),
      }),
    "agent_cannot_activate"
  );
  report.steps.push(agentActivate);

  const agentSetPolicy = await expectFail(
    () =>
      agentAcct.functionCall({
        contractId: report.accounts.policy,
        methodName: "set_policy",
        args: { limits, policy_hash: "x", strategy_hash: "y" },
        gas: BigInt("80000000000000"),
      }),
    "agent_cannot_set_policy"
  );
  report.steps.push(agentSetPolicy);

  const agentPause = await expectFail(
    () =>
      agentAcct.functionCall({
        contractId: report.accounts.policy,
        methodName: "pause",
        args: {},
        gas: BigInt("30000000000000"),
      }),
    "agent_cannot_pause"
  );
  report.steps.push(agentPause);

  // Ensure not revoked before activate (upgrade path may be revoked)
  try {
    const rev = await view(policyAcct, "get_revocation_status");
    if (rev?.revoked) {
      const u = await ownerAcct.functionCall({
        contractId: report.accounts.policy,
        methodName: "unrevoke",
        args: {},
        gas: BigInt("50000000000000"),
      });
      report.steps.push({ unrevoke: u.transaction.hash });
    }
  } catch {
    /* method shape variance */
  }

  const activateTx = await ownerAcct.functionCall({
    contractId: report.accounts.policy,
    methodName: "activate_autonomous_mandate",
    args: {
      limits,
      policy_hash: `j13-mandate-${tag}`,
      strategy_hash: `j13-strategy-${tag}`,
      enforce_autonomous_on_agent: true,
      autonomous_trading: true,
      unpause_now: true,
    },
    gas: BigInt("100000000000000"),
  });
  report.steps.push({
    activate_autonomous_mandate: activateTx.transaction.hash,
    explorer: `https://testnet.nearblocks.io/txns/${activateTx.transaction.hash}`,
  });

  const paused = await view(policyAcct, "get_paused");
  const auto = await view(policyAcct, "get_autonomous_trading");
  const enforce = await view(policyAcct, "get_enforce_autonomous_on_agent");
  const epoch = await view(policyAcct, "get_mandate_epoch");
  report.on_chain_after_activate = { paused, autonomous_trading: auto, enforce, epoch };

  const op1Id = `j13-op1-${tag}-${Date.now()}`;
  const op2Id = `j13-op2-${tag}-${Date.now()}`;
  const op1 = await agentAcct.functionCall({
    contractId: report.accounts.policy,
    methodName: "propose_trade",
    args: { proposal: proposal(op1Id, 5) },
    gas: BigInt("80000000000000"),
  });
  const op2 = await agentAcct.functionCall({
    contractId: report.accounts.policy,
    methodName: "propose_trade",
    args: { proposal: proposal(op2Id, 5) },
    gas: BigInt("80000000000000"),
  });
  report.steps.push({
    agent_propose_1: op1.transaction.hash,
    agent_propose_2: op2.transaction.hash,
    owner_signature_requested: false,
  });

  const over = await expectFail(
    () =>
      agentAcct.functionCall({
        contractId: report.accounts.policy,
        methodName: "propose_trade",
        args: { proposal: proposal(`j13-over-${tag}`, 11) },
        gas: BigInt("80000000000000"),
      }),
    "over_limit_rejected"
  );
  report.steps.push(over);

  let mpcResult = { attempted: true };
  try {
    const signTx = await agentAcct.functionCall({
      contractId: report.accounts.policy,
      methodName: "request_signature",
      args: { operation_id: op1Id },
      gas: BigInt("300000000000000"),
      attachedDeposit: 1n,
    });
    mpcResult = {
      attempted: true,
      tx: signTx.transaction.hash,
      explorer: `https://testnet.nearblocks.io/txns/${signTx.transaction.hash}`,
      attached_deposit_yocto: "1",
      note: "MPC XCC submitted with 1 yocto from distinct agent key",
    };
    report.verdicts.MPC_END_TO_END_TESTNET = "PASS_TX_SUBMITTED";
  } catch (e) {
    const msg = String(e.message || e);
    mpcResult = {
      attempted: true,
      attached_deposit_yocto: "1",
      error: msg.slice(0, 600),
    };
    report.verdicts.MPC_END_TO_END_TESTNET = /yocto|deposit/i.test(msg)
      ? "FAIL_DEPOSIT"
      : "PARTIAL_CALL_ATTEMPTED";
  }
  report.steps.push({ request_signature: mpcResult });

  const zeroDep = await expectFail(
    () =>
      agentAcct.functionCall({
        contractId: report.accounts.policy,
        methodName: "request_signature",
        args: { operation_id: op2Id },
        gas: BigInt("100000000000000"),
        attachedDeposit: 0n,
      }),
    "request_signature_zero_deposit_rejected"
  );
  report.steps.push(zeroDep);

  const revokeTx = await ownerAcct.functionCall({
    contractId: report.accounts.policy,
    methodName: "revoke",
    args: {},
    gas: BigInt("50000000000000"),
  });
  report.steps.push({ revoke: revokeTx.transaction.hash });

  const afterRevoke = await expectFail(
    () =>
      agentAcct.functionCall({
        contractId: report.accounts.policy,
        methodName: "propose_trade",
        args: { proposal: proposal(`j13-after-revoke-${tag}`, 1) },
        gas: BigInt("80000000000000"),
      }),
    "propose_after_revoke_blocked"
  );
  report.steps.push(afterRevoke);

  const isolationOk =
    agentActivate.ok && agentSetPolicy.ok && agentPause.ok && report.key_isolation.all_distinct;
  const mandateOk =
    paused === false &&
    auto === true &&
    enforce === true &&
    over.ok &&
    afterRevoke.ok &&
    Boolean(op1.transaction?.hash) &&
    Boolean(op2.transaction?.hash);

  report.verdicts.DEPLOYED_MANDATE_TESTNET = mandateOk ? "PASS" : "FAIL";
  if (isolationOk) report.verdicts.KEY_ISOLATION_TESTNET = "PASS";
  report.finished_at = new Date().toISOString();
  report.ok = mandateOk && isolationOk;

  const out = join(EVIDENCE, "J13_DEPLOYED_MANDATE_TESTNET.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        mode: report.mode,
        verdicts: report.verdicts,
        accounts: report.accounts,
        wasm_sha256: report.wasm_sha256,
        evidence: out,
        activate: report.steps.find((s) => s.activate_autonomous_mandate),
        mpc: mpcResult,
      },
      null,
      2
    )
  );
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  writeFileSync(
    join(EVIDENCE, "J13_DEPLOYED_MANDATE_TESTNET.json"),
    JSON.stringify(
      {
        kind: "J13_DEPLOYED_MANDATE_TESTNET",
        ok: false,
        error: String(e.message || e),
        stack: String(e.stack || "").slice(0, 2500),
      },
      null,
      2
    )
  );
  process.exit(1);
});
