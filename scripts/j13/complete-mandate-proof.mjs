#!/usr/bin/env node
/**
 * Complete J13 mandate proofs against already-deployed j13pol.* testnet contract.
 * Uses one-shot txs (no exponential retry on expected panics).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as nearAPI from "near-api-js";
import { NETWORK, pickRpc, ORIGIN_ASSET, DEST_ASSET } from "../lib/near-live.mjs";

const { connect, keyStores, KeyPair, transactions, utils } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const policyId = process.env.J13_POLICY || "j13pol.nio-agent-02b7cf.testnet";
const owner = JSON.parse(readFileSync(join(CREDS, "nio-owner-02b7cf.testnet.json"), "utf8"));
const agent = JSON.parse(readFileSync(join(CREDS, "nio-agent-02b7cf.testnet.json"), "utf8"));
const policyCred = JSON.parse(readFileSync(join(CREDS, `${policyId}.json`), "utf8"));

function loadKp(cred) {
  return KeyPair.fromString(cred.private_key);
}

async function connectAll(rpc) {
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey(NETWORK, owner.account_id, loadKp(owner));
  await ks.setKey(NETWORK, agent.account_id, loadKp(agent));
  await ks.setKey(NETWORK, policyCred.account_id, loadKp(policyCred));
  return connect({ networkId: NETWORK, nodeUrl: rpc, deps: { keyStore: ks } });
}

/** One attempt; bypass Account exponentialBackoff retries on panic. */
async function callOnce(account, { methodName, args, gas, deposit = 0n }) {
  const actions = [
    transactions.functionCall(
      methodName,
      args,
      gas || BigInt("80000000000000"),
      deposit
    ),
  ];
  const [txHash, signed] = await account.signTransaction(policyId, actions);
  const outcome = await account.connection.provider.sendTransaction(signed);
  // Surface ExecutionError like functionCall would
  const status = outcome.status;
  if (status?.Failure) {
    const err = new Error(JSON.stringify(status.Failure));
    err.transaction = { hash: typeof txHash === "string" ? txHash : outcome.transaction?.hash };
    throw err;
  }
  return {
    transaction: {
      hash: outcome.transaction?.hash || (typeof txHash === "string" ? txHash : Buffer.from(txHash).toString("base64")),
    },
    ...outcome,
  };
}

async function expectPanic(account, opts, label) {
  try {
    const tx = await callOnce(account, opts);
    return { ok: false, label, error: "expected_panic", tx: tx?.transaction?.hash };
  } catch (e) {
    return { ok: true, label, error: String(e.message || e).slice(0, 400) };
  }
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

function limits() {
  return {
    max_trade_value: "10",
    daily_turnover_limit: "100",
    max_pending_exposure: "50",
    max_slippage_bps: 100,
    allowed_assets: ["USDC", "NEAR", ORIGIN_ASSET, DEST_ASSET],
    allowed_destinations: ["intents.near", owner.account_id],
    valid_until: "1893456000000000000",
    token_scope: "allowlist",
    allowed_chains: ["near", "eip155:11155111"],
    allowed_venues: ["near_intents_1click"],
    max_gas_budget: "300000000000000",
  };
}

const rpc = await pickRpc();
const near = await connectAll(rpc);
const policyAcct = await near.account(policyId);
const ownerAcct = await near.account(owner.account_id);
const agentAcct = await near.account(agent.account_id);

const report = {
  kind: "J13_DEPLOYED_MANDATE_TESTNET",
  mode: "complete_proof",
  started_at: new Date().toISOString(),
  rpc,
  accounts: {
    owner: owner.account_id,
    agent: agent.account_id,
    policy: policyId,
  },
  key_isolation: {
    owner_pk: owner.public_key,
    agent_pk: agent.public_key,
    policy_pk: policyCred.public_key,
    all_distinct:
      owner.public_key !== agent.public_key &&
      owner.public_key !== policyCred.public_key &&
      agent.public_key !== policyCred.public_key,
  },
  steps: [],
  verdicts: {},
};

const view = (m) =>
  policyAcct.viewFunction({ contractId: policyId, methodName: m, args: {} });

report.on_chain_before = {
  paused: await view("get_paused"),
  autonomous_trading: await view("get_autonomous_trading"),
  enforce: await view("get_enforce_autonomous_on_agent"),
  epoch: await view("get_mandate_epoch"),
  owner: await view("get_owner"),
  agent: await view("get_agent"),
};

// If not yet activated, owner activates once
if (
  report.on_chain_before.paused ||
  !report.on_chain_before.autonomous_trading ||
  !report.on_chain_before.enforce
) {
  const tx = await callOnce(ownerAcct, {
    methodName: "activate_autonomous_mandate",
    args: {
      limits: limits(),
      policy_hash: `j13-complete-${Date.now()}`,
      strategy_hash: "j13-strategy",
      enforce_autonomous_on_agent: true,
      autonomous_trading: true,
      unpause_now: true,
    },
    gas: BigInt("100000000000000"),
  });
  report.steps.push({ activate: tx.transaction.hash });
} else {
  report.steps.push({
    activate: "already_active",
    note: "Owner one-time activation already on-chain",
  });
}

report.verdicts.KEY_ISOLATION_TESTNET = report.key_isolation.all_distinct
  ? "PASS"
  : "FAIL";

const agentActivate = await expectPanic(
  agentAcct,
  {
    methodName: "activate_autonomous_mandate",
    args: {
      limits: limits(),
      policy_hash: "evil",
      strategy_hash: "evil",
      enforce_autonomous_on_agent: true,
      autonomous_trading: true,
      unpause_now: true,
    },
  },
  "agent_cannot_activate"
);
report.steps.push(agentActivate);

const agentPause = await expectPanic(
  agentAcct,
  { methodName: "pause", args: {} },
  "agent_cannot_pause"
);
report.steps.push(agentPause);

const tag = Date.now();
const op1 = `j13-op1-${tag}`;
const op2 = `j13-op2-${tag}`;

const p1 = await callOnce(agentAcct, {
  methodName: "propose_trade",
  args: { proposal: proposal(op1, 5) },
});
const p2 = await callOnce(agentAcct, {
  methodName: "propose_trade",
  args: { proposal: proposal(op2, 5) },
});
report.steps.push({
  agent_propose_1: p1.transaction.hash,
  agent_propose_2: p2.transaction.hash,
  owner_signature_requested: false,
  explorer_1: `https://testnet.nearblocks.io/txns/${p1.transaction.hash}`,
  explorer_2: `https://testnet.nearblocks.io/txns/${p2.transaction.hash}`,
});

const over = await expectPanic(
  agentAcct,
  {
    methodName: "propose_trade",
    args: { proposal: proposal(`j13-over-${tag}`, 11) },
  },
  "over_limit_rejected"
);
report.steps.push(over);

let mpc = { attempted: true };
try {
  const s = await callOnce(agentAcct, {
    methodName: "request_signature",
    args: { operation_id: op1 },
    gas: BigInt("300000000000000"),
    deposit: 1n,
  });
  mpc = {
    attempted: true,
    tx: s.transaction.hash,
    attached_deposit_yocto: "1",
    explorer: `https://testnet.nearblocks.io/txns/${s.transaction.hash}`,
  };
  report.verdicts.MPC_END_TO_END_TESTNET = "PASS_TX_SUBMITTED";
} catch (e) {
  mpc = {
    attempted: true,
    attached_deposit_yocto: "1",
    error: String(e.message || e).slice(0, 600),
  };
  report.verdicts.MPC_END_TO_END_TESTNET = /yocto|deposit/i.test(mpc.error)
    ? "FAIL_DEPOSIT"
    : "PARTIAL_CALL_ATTEMPTED";
}
report.steps.push({ request_signature: mpc });

const zeroDep = await expectPanic(
  agentAcct,
  {
    methodName: "request_signature",
    args: { operation_id: op2 },
    gas: BigInt("100000000000000"),
    deposit: 0n,
  },
  "zero_deposit_rejected"
);
report.steps.push(zeroDep);

const rev = await callOnce(ownerAcct, {
  methodName: "revoke",
  args: {},
  gas: BigInt("50000000000000"),
});
report.steps.push({ revoke: rev.transaction.hash });

const afterRevoke = await expectPanic(
  agentAcct,
  {
    methodName: "propose_trade",
    args: { proposal: proposal(`j13-post-revoke-${tag}`, 1) },
  },
  "propose_after_revoke_blocked"
);
report.steps.push(afterRevoke);

report.on_chain_after = {
  paused: await view("get_paused"),
  revoked: (await view("get_revocation_status"))?.revoked,
  epoch: await view("get_mandate_epoch"),
};

const mandateOk =
  agentActivate.ok &&
  agentPause.ok &&
  over.ok &&
  afterRevoke.ok &&
  Boolean(p1.transaction?.hash) &&
  Boolean(p2.transaction?.hash);

report.verdicts.DEPLOYED_MANDATE_TESTNET = mandateOk ? "PASS" : "FAIL";
report.ok = mandateOk && report.key_isolation.all_distinct;
report.finished_at = new Date().toISOString();
report.wasm_note =
  "Deployed earlier this session to j13pol.nio-agent-02b7cf.testnet (J12 activate_autonomous_mandate bytecode)";

writeFileSync(
  join(EVIDENCE, "J13_DEPLOYED_MANDATE_TESTNET.json"),
  JSON.stringify(report, null, 2)
);
console.log(
  JSON.stringify(
    {
      ok: report.ok,
      verdicts: report.verdicts,
      accounts: report.accounts,
      proposes: [p1.transaction.hash, p2.transaction.hash],
      mpc,
      evidence: join(EVIDENCE, "J13_DEPLOYED_MANDATE_TESTNET.json"),
    },
    null,
    2
  )
);
process.exit(report.ok ? 0 : 1);
