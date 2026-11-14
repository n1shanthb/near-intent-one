#!/usr/bin/env node
/**
 * J14 P2 — Autonomous execution service against TESTNET policy.
 * Uses hardened non-interactive adapters. Does NOT claim E2E settlement
 * from MPC signed alone.
 *
 * HARD STOP: testnet only. No mainnet.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import * as nearAPI from "near-api-js";
import { NETWORK, MPC, VERIFIER, pickRpc, assertNotDemo } from "../lib/near-live.mjs";
import {
  deterministicTradeScenario,
  runAutonomousExecution,
  EXEC_MODE,
} from "../../packages/autonomous/index.mjs";

const { connect, keyStores, KeyPair, transactions } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "docs", "evidence");
const NEW_WASM = join(
  ROOT,
  "contracts/policy/target/wasm32-unknown-unknown/release/policy.wasm"
);
mkdirSync(EVIDENCE, { recursive: true });

function loadCred(id) {
  return JSON.parse(readFileSync(join(CREDS, `${id}.json`), "utf8"));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clearAccessKeyCache(account) {
  if (account?.accessKeyByPublicKeyCache) {
    account.accessKeyByPublicKeyCache = {};
  }
}

async function callOnce(account, receiverId, { methodName, args, gas, deposit = 0n }) {
  const actions = [
    transactions.functionCall(
      methodName,
      args,
      gas || BigInt("100000000000000"),
      deposit
    ),
  ];
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      clearAccessKeyCache(account);
      const [, signed] = await account.signTransaction(receiverId, actions);
      const outcome = await account.connection.provider.sendTransaction(signed);
      if (outcome.status?.Failure) {
        throw new Error(JSON.stringify(outcome.status.Failure));
      }
      clearAccessKeyCache(account);
      await sleep(250);
      return outcome;
    } catch (e) {
      lastErr = e;
      if (!/InvalidNonce|nonce/i.test(String(e.message || e))) throw e;
      clearAccessKeyCache(account);
      await sleep(500 + attempt * 250);
    }
  }
  throw lastErr;
}

function extractSignedEvent(outcome) {
  const logs = [];
  for (const receipt of outcome.receipts_outcome || []) {
    for (const line of receipt.outcome?.logs || []) logs.push(line);
  }
  const hit = logs.find((l) => /signed|SignatureResponded|request_signature/i.test(l));
  return { logs: logs.slice(0, 20), signed_event_log: hit || null };
}

const report = {
  kind: "J14_E2E_EXECUTION_SERVICE",
  started_at: new Date().toISOString(),
  network: NETWORK,
  hard_stop_mainnet: true,
  steps: [],
  labels: {
    evm_routes: "LOCAL_FORK_OR_UNSUPPORTED — not claimed as live EVM settlement",
    mpc_signed_alone: "NOT_SETTLEMENT",
  },
  verdict: "NO_GO",
};

if (!existsSync(NEW_WASM)) {
  report.error = "missing_new_wasm";
  writeFileSync(join(EVIDENCE, "J14_E2E_EXECUTION_SERVICE.json"), JSON.stringify(report, null, 2));
  process.exit(1);
}

const owner = loadCred("nio-owner-02b7cf.testnet");
const agent = loadCred("nio-agent-02b7cf.testnet");
const tag = randomBytes(2).toString("hex");

const rpc = await pickRpc();
report.rpc = rpc;

const sponsorCandidates = [
  "nio-c-recon-857107.testnet",
  "nio-c-owner-857107.testnet",
  "nio-c-agent-857107.testnet",
  "nio-j13-f66f-owner.testnet",
  "nio-j13-998a-owner.testnet",
  "nio-j13-e974-owner.testnet",
  "nio-j13-4dd4-owner.testnet",
  "nio-j13-edcb-owner.testnet",
];
let sponsor = null;
{
  const ksProbe = new keyStores.InMemoryKeyStore();
  for (const id of sponsorCandidates) {
    const c = loadCred(id);
    await ksProbe.setKey(NETWORK, c.account_id, KeyPair.fromString(c.private_key));
  }
  const probe = await connect({
    networkId: NETWORK,
    nodeUrl: rpc,
    deps: { keyStore: ksProbe },
  });
  for (const id of sponsorCandidates) {
    try {
      const bal = await (await probe.account(id)).getAccountBalance();
      if (BigInt(bal.available) >= 7800000000000000000000000n) {
        sponsor = loadCred(id);
        break;
      }
    } catch {
      /* next */
    }
  }
  if (!sponsor) throw new Error("no_funded_sponsor_for_e2e");
}

const policyKp = KeyPair.fromRandom("ed25519");
const policyId = `j14e${tag}.${sponsor.account_id}`;
assertNotDemo(policyId);
writeFileSync(
  join(CREDS, `${policyId}.json`),
  JSON.stringify(
    {
      account_id: policyId,
      public_key: policyKp.getPublicKey().toString(),
      private_key: policyKp.toString(),
      role: "policy",
      gate: "J14",
    },
    null,
    2
  )
);
report.accounts = {
  owner: owner.account_id,
  agent: agent.account_id,
  policy: policyId,
  sponsor: sponsor.account_id,
};

const ks = new keyStores.InMemoryKeyStore();
for (const c of [sponsor, owner, agent]) {
  await ks.setKey(NETWORK, c.account_id, KeyPair.fromString(c.private_key));
}
await ks.setKey(NETWORK, policyId, policyKp);
const near = await connect({ networkId: NETWORK, nodeUrl: rpc, deps: { keyStore: ks } });
const sponsorAcct = await near.account(sponsor.account_id);
const ownerAcct = await near.account(owner.account_id);
const agentAcct = await near.account(agent.account_id);

await sponsorAcct.createAccount(
  policyId,
  policyKp.getPublicKey().toString(),
  BigInt("7500000000000000000000000")
);
await sleep(600);
const policyAcct = await near.account(policyId);
const wasm = readFileSync(NEW_WASM);
{
  let out;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [, signed] = await policyAcct.signTransaction(policyId, [
        transactions.deployContract(wasm),
      ]);
      out = await policyAcct.connection.provider.sendTransaction(signed);
      if (out.status?.Failure) throw new Error(JSON.stringify(out.status.Failure));
      break;
    } catch (e) {
      if (!/InvalidNonce|nonce/i.test(String(e.message || e))) throw e;
      await sleep(500 + attempt * 250);
    }
  }
  report.steps.push({ deploy: out?.transaction?.hash });
}
await sleep(500);

const limits = {
  max_trade_value: "1000000",
  daily_turnover_limit: "5000000",
  max_pending_exposure: "2000000",
  max_slippage_bps: 100,
  allowed_assets: ["USDC", "NEAR"],
  allowed_destinations: ["intents.near", owner.account_id],
  valid_until: "1893456000000000000",
  token_scope: "allowlist",
  allowed_chains: ["near", "eip155:11155111"],
  allowed_venues: ["near_intents_1click"],
  max_gas_budget: "300000000000000",
};

await callOnce(policyAcct, policyId, {
  methodName: "new",
  args: {
    owner: owner.account_id,
    agent: agent.account_id,
    mpc_signer: MPC,
    portfolio_id: `j14-e2e-${tag}`,
    verifying_contract: VERIFIER,
    limits,
  },
});

await callOnce(ownerAcct, policyId, {
  methodName: "activate_autonomous_mandate",
  args: {
    limits,
    policy_hash: `j14-e2e-${tag}`,
    strategy_hash: "j14-e2e-strategy",
    enforce_autonomous_on_agent: true,
    autonomous_trading: true,
    unpause_now: true,
  },
});
report.steps.push({ activate: "ok" });

const onChain = {
  paused: await policyAcct.viewFunction({
    contractId: policyId,
    methodName: "get_paused",
  }),
  revoked: false,
  autonomous_trading: await policyAcct.viewFunction({
    contractId: policyId,
    methodName: "get_autonomous_trading",
  }),
  enforce_autonomous_on_agent: await policyAcct.viewFunction({
    contractId: policyId,
    methodName: "get_enforce_autonomous_on_agent",
  }),
  mandate_epoch: await policyAcct.viewFunction({
    contractId: policyId,
    methodName: "get_mandate_epoch",
  }),
  limits: await policyAcct.viewFunction({
    contractId: policyId,
    methodName: "get_limits",
  }),
};
report.on_chain = onChain;

const fitted = "1000000"; // $1 USDC raw (6 decimals) — fitter bound
const decision = deterministicTradeScenario({
  strategistSize: "100000000", // $100 — must NOT execute
  fittedSize: fitted,
  mandateEpoch: Number(onChain.mandate_epoch),
  destination: "intents.near",
});

const journalPath = join(EVIDENCE, `j14-e2e-journal-${tag}.sqlite`);
process.env.NIO_TX_JOURNAL_SECRET =
  process.env.NIO_TX_JOURNAL_SECRET ||
  createHash("sha256").update(`j14-testnet-journal-${tag}`).digest("hex");

const adapters = {
  propose: async ({ amount_raw, operation_id }) => {
    if (String(amount_raw) !== fitted) {
      return { ok: false, reason: `amount_not_fitter_bound:${amount_raw}` };
    }
    // Contract enforces min_out >= amount * (10000 - max_slippage_bps) / 10000
    const amt = BigInt(amount_raw);
    const minOut = ((amt * 9900n) / 10000n).toString();
    const proposal = {
      operation_id,
      amount_in: String(amount_raw),
      asset_in: "USDC",
      asset_out: "NEAR",
      destination: "intents.near",
      min_amount_out: minOut,
      intent_deadline: "9000000000000000000",
      payload_commitment: createHash("sha256")
        .update(`${operation_id}:${amount_raw}`)
        .digest("hex"),
    };
    try {
      const out = await callOnce(agentAcct, policyId, {
        methodName: "propose_trade",
        args: { proposal },
      });
      return {
        ok: true,
        operation_id,
        amount_raw: String(amount_raw),
        min_amount_out: minOut,
        tx: out.transaction.hash,
        explorer: `https://testnet.nearblocks.io/txns/${out.transaction.hash}`,
        owner_approval_required: false,
      };
    } catch (e) {
      return { ok: false, reason: String(e.message || e).slice(0, 600) };
    }
  },
  requestSignature: async ({ operation_id }) => {
    try {
      const out = await callOnce(agentAcct, policyId, {
        methodName: "request_signature",
        args: { operation_id },
        gas: BigInt("300000000000000"),
        deposit: 1n,
      });
      const ev = extractSignedEvent(out);
      return {
        ok: true,
        operation_id,
        tx: out.transaction.hash,
        explorer: `https://testnet.nearblocks.io/txns/${out.transaction.hash}`,
        attached_deposit_yocto: "1",
        // Journal expects hex bytes for signed raw; placeholder is NOT a broadcastable EVM tx
        signed_raw: Buffer.from(
          `TESTNET_MPC_PENDING:${out.transaction.hash}`,
          "utf8"
        ).toString("hex"),
        nonce: String(Date.now()),
        mpc_event: ev,
        note: "MPC request submitted; signed event ≠ cross-chain settlement",
      };
    } catch (e) {
      return {
        ok: false,
        reason: String(e.message || e).slice(0, 600),
        ambiguous: /timeout|unknown|connection|502|503/i.test(String(e.message || e)),
      };
    }
  },
  // Broadcast of reconstructed EVM tx is unsupported for this NEAR-intents dry path
  broadcast: null,
  settle: async ({ operation_id, tx_hash }) => ({
    ok: false,
    status: "UNSUPPORTED_ROUTE",
    label: "LOCAL_FORK_OR_UNSUPPORTED",
    operation_id,
    tx_hash: tx_hash || null,
    note: "No genuine cross-chain settlement claimed; MPC signed ≠ settled",
  }),
  reconcile: async () => ({
    ok: false,
    reason: "no_independent_settlement_evidence",
    invented: false,
  }),
};

const trace = await runAutonomousExecution({
  decision,
  mandate: { trading_enabled: true },
  onChain,
  quote: {
    amount_in: fitted,
    destination: "intents.near",
    asset_in: "USDC",
    stale: false,
  },
  mode: EXEC_MODE.TESTNET,
  adapters,
  journalPath,
  simulateBroadcast: true,
});

report.execution_trace = trace;
report.fitter_binding = {
  strategist_proposed: "100000000",
  fitter_fitted: fitted,
  plan_amount: trace.plan?.amount_raw,
  bound_ok: trace.plan?.amount_raw === fitted,
};
report.owner_per_trade_approval = false;
report.contract_authority =
  "propose+request_signature require on-chain mandate; LLM/HTTP cannot replace";

// Honest verdicts
const proposeOk = trace.steps?.some((s) => s.propose?.ok && s.propose?.tx);
const mpcOk = trace.steps?.some((s) => s.request_signature?.ok && s.request_signature?.tx);
const settleClaimed = trace.steps?.some(
  (s) => s.settle?.ok && !s.settle?.skipped && s.settle?.status !== "UNSUPPORTED_ROUTE"
);

report.verdicts = {
  FITTER_BOUND_PROPOSE: report.fitter_binding.bound_ok && proposeOk ? "PASS" : "FAIL",
  MPC_REQUEST_SIGNATURE: mpcOk ? "PASS" : "FAIL",
  END_TO_END_TESTNET_SETTLEMENT: settleClaimed
    ? "PASS"
    : "NO_GO_UNSUPPORTED_OR_UNSIGNED_SETTLE",
  AUTONOMOUS_KEEPER_EXECUTION:
    proposeOk && mpcOk && report.fitter_binding.bound_ok
      ? "PASS_THROUGH_MPC_PARTIAL"
      : "FAIL",
};

report.verdict =
  report.verdicts.FITTER_BOUND_PROPOSE === "PASS" &&
  report.verdicts.MPC_REQUEST_SIGNATURE === "PASS"
    ? "PARTIAL_PASS_NO_SETTLEMENT_CLAIM"
    : "NO_GO";

report.finished_at = new Date().toISOString();
writeFileSync(
  join(EVIDENCE, "J14_E2E_EXECUTION_SERVICE.json"),
  JSON.stringify(report, null, 2)
);
console.log(
  JSON.stringify(
    {
      verdict: report.verdict,
      verdicts: report.verdicts,
      policy: policyId,
      amount_raw: trace.plan?.amount_raw,
      evidence: join(EVIDENCE, "J14_E2E_EXECUTION_SERVICE.json"),
    },
    null,
    2
  )
);
process.exit(
  report.verdicts.FITTER_BOUND_PROPOSE === "PASS" &&
    report.verdicts.MPC_REQUEST_SIGNATURE === "PASS"
    ? 0
    : 1
);
