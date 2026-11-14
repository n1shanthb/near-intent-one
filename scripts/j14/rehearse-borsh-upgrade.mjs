#!/usr/bin/env node
/**
 * J14 P0 — Rehearse mainnet-compatible Borsh upgrade on testnet.
 * 1) Deploy EXACT deployed mainnet WASM (3bc7c112…) to fresh account
 * 2) Init + populate nonempty state (limits, pending, turnover, raw flags)
 * 3) Upgrade to current local WASM (E433C6CF… with activate_autonomous_mandate)
 * 4) Verify state preserved; new methods resolve
 *
 * HARD STOP: testnet only.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import * as nearAPI from "near-api-js";
import { NETWORK, MPC, VERIFIER, pickRpc, assertNotDemo } from "../lib/near-live.mjs";

const { connect, keyStores, KeyPair, transactions } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "docs", "evidence");
const OLD_WASM = join(ROOT, "artifacts", "mainnet", "policy.wasm");
const NEW_WASM = join(
  ROOT,
  "contracts/policy/target/wasm32-unknown-unknown/release/policy.wasm"
);

mkdirSync(EVIDENCE, { recursive: true });

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex").toUpperCase();
}

function loadCred(id) {
  return JSON.parse(readFileSync(join(CREDS, `${id}.json`), "utf8"));
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
        gate: "J14",
      },
      null,
      2
    )
  );
  return path;
}

async function connectWith(creds, rpc) {
  const ks = new keyStores.InMemoryKeyStore();
  for (const c of creds) {
    await ks.setKey(NETWORK, c.account_id, KeyPair.fromString(c.private_key));
  }
  return connect({ networkId: NETWORK, nodeUrl: rpc, deps: { keyStore: ks } });
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitNonceAdvance(account, pkStr, minNonce, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const keys = await account.getAccessKeys();
    const hit = keys.find((k) => k.public_key === pkStr);
    const n = hit?.access_key?.nonce;
    if (n !== undefined && BigInt(n) >= BigInt(minNonce)) return n;
    await sleep(400 + i * 100);
  }
  return null;
}

function clearAccessKeyCache(account) {
  // near-api-js caches access-key nonces; stale cache → InvalidNonce after prior sendTransaction
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
      const msg = String(e.message || e);
      if (!/InvalidNonce|nonce/i.test(msg)) throw e;
      clearAccessKeyCache(account);
      await sleep(500 + attempt * 250);
    }
  }
  throw lastErr;
}

async function view(acct, method, args = {}) {
  return acct.viewFunction({ contractId: acct.accountId, methodName: method, args });
}

function mainnetLikeLimits(ownerId) {
  return {
    max_trade_value: "5000000",
    daily_turnover_limit: "25000000",
    max_pending_exposure: "10000000",
    max_slippage_bps: 100,
    allowed_assets: [
      "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
      "USDC",
      "NEAR",
    ],
    allowed_destinations: [ownerId, "intents.near", "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4"],
    valid_until: "1798761600000000000",
    token_scope: "allowlist",
    allowed_chains: ["near", "eip155:1", "eip155:42161", "eip155:8453"],
    allowed_venues: ["near_intents_1click"],
    max_gas_budget: "2500000000000000",
  };
}

function proposal(id, amount, dest) {
  return {
    operation_id: id,
    amount_in: String(amount),
    asset_in: "USDC",
    asset_out: "NEAR",
    destination: dest,
    min_amount_out: String(Math.max(1, Math.floor((Number(amount) * 99) / 100))),
    intent_deadline: "9000000000000000000",
    payload_commitment:
      "521da91dc9bddb625bd0679d9e735def558761a34653624f5954f44bce6443a9",
  };
}

const report = {
  kind: "J14_BORSH_UPGRADE_REHEARSAL",
  started_at: new Date().toISOString(),
  network: NETWORK,
  hard_stop_mainnet: true,
  steps: [],
  snapshots: {},
  verdict: "NO_GO",
};

if (!existsSync(OLD_WASM) || !existsSync(NEW_WASM)) {
  report.error = "missing_wasm_artifacts";
  writeFileSync(join(EVIDENCE, "J14_BORSH_UPGRADE_REHEARSAL.json"), JSON.stringify(report, null, 2));
  process.exit(1);
}

const oldBuf = readFileSync(OLD_WASM);
const newBuf = readFileSync(NEW_WASM);
report.old_wasm = { sha256: sha256(oldBuf), bytes: oldBuf.length, path: OLD_WASM };
report.new_wasm = { sha256: sha256(newBuf), bytes: newBuf.length, path: NEW_WASM };
report.mainnet_deployed_sha256_expected =
  "3BC7C1120A1F593A4C96FF58171CE9521F780CEEC0427D97F90F0CAC9ECC4F90";
report.old_matches_mainnet_artifact =
  report.old_wasm.sha256 === report.mainnet_deployed_sha256_expected;

const rpc = await pickRpc();
report.rpc = rpc;
report.sponsor_selection = "auto_funded_faucet";

// Prefer a funded faucet leftover with ≥7.5N available for child account.
const sponsorCandidates = [
  "nio-j13-4dd4-owner.testnet",
  "nio-j13-998a-owner.testnet",
  "nio-j13-e974-owner.testnet",
  "nio-j13-f66f-owner.testnet",
  "nio-j13-edcb-owner.testnet",
  "nio-j13-a441-owner.testnet",
];
let sponsor = null;
{
  const probeNear = await connectWith(
    sponsorCandidates.map((id) => loadCred(id)),
    rpc
  );
  for (const id of sponsorCandidates) {
    try {
      const bal = await (await probeNear.account(id)).getAccountBalance();
      if (BigInt(bal.available) >= 7500000000000000000000000n) {
        sponsor = loadCred(id);
        break;
      }
    } catch {
      /* next */
    }
  }
  if (!sponsor) throw new Error("no_funded_sponsor_for_upgrade_rehearsal");
}
const owner = loadCred("nio-owner-02b7cf.testnet");
const agent = loadCred("nio-agent-02b7cf.testnet");
const tag = randomBytes(2).toString("hex");
const policyKp = KeyPair.fromRandom("ed25519");
const policyId = `j14u${tag}.${sponsor.account_id}`;
assertNotDemo(policyId);
saveCred(policyId, "policy", policyKp);
const policyCred = {
  account_id: policyId,
  public_key: policyKp.getPublicKey().toString(),
  private_key: policyKp.toString(),
};
report.accounts = {
  owner: owner.account_id,
  agent: agent.account_id,
  policy: policyId,
  sponsor: sponsor.account_id,
};

const near = await connectWith([sponsor, owner, agent, policyCred], rpc);
const sponsorAcct = await near.account(sponsor.account_id);
const ownerAcct = await near.account(owner.account_id);
const agentAcct = await near.account(agent.account_id);

// Fund fresh policy (~7.2N) — old+new wasm storage fits under ~7N when replacing code
await sponsorAcct.createAccount(
  policyId,
  policyKp.getPublicKey().toString(),
  BigInt("7200000000000000000000000")
);
report.steps.push({ create_account: policyId });

const policyAcct = await near.account(policyId);

// 1) Deploy OLD (mainnet-identical) WASM
{
  let out;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      clearAccessKeyCache(policyAcct);
      const [, signed] = await policyAcct.signTransaction(policyId, [
        transactions.deployContract(oldBuf),
      ]);
      out = await policyAcct.connection.provider.sendTransaction(signed);
      if (out.status?.Failure) throw new Error(JSON.stringify(out.status.Failure));
      break;
    } catch (e) {
      lastErr = e;
      if (!/InvalidNonce|nonce/i.test(String(e.message || e))) throw e;
      clearAccessKeyCache(policyAcct);
      await sleep(500 + attempt * 250);
    }
  }
  if (!out) throw lastErr || new Error("deploy_old_failed");
  clearAccessKeyCache(policyAcct);
  await sleep(500);
  report.steps.push({
    deploy_old: out.transaction.hash,
    explorer: `https://testnet.nearblocks.io/txns/${out.transaction.hash}`,
  });
}

const limits = mainnetLikeLimits(owner.account_id);
const portfolioId = `j14-migrate-${tag}`;

await callOnce(policyAcct, policyId, {
  methodName: "new",
  args: {
    owner: owner.account_id,
    agent: agent.account_id,
    mpc_signer: MPC,
    portfolio_id: portfolioId,
    verifying_contract: VERIFIER,
    limits,
  },
});
report.steps.push({ init_old: "ok" });

await callOnce(ownerAcct, policyId, {
  methodName: "set_intents_signer_id",
  args: { intents_signer_id: "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4" },
  gas: BigInt("30000000000000"),
});
await callOnce(ownerAcct, policyId, {
  methodName: "set_policy",
  args: {
    limits,
    policy_hash: "j14-pre-upgrade-policy-hash",
    strategy_hash: "j14-pre-upgrade-strategy-hash",
  },
});
await callOnce(ownerAcct, policyId, {
  methodName: "set_autonomous_trading",
  args: { enabled: false },
  gas: BigInt("30000000000000"),
});
await callOnce(ownerAcct, policyId, {
  methodName: "unpause",
  args: {},
  gas: BigInt("30000000000000"),
});

const opId = `j14-pending-${tag}`;
await callOnce(agentAcct, policyId, {
  methodName: "propose_trade",
  args: { proposal: proposal(opId, 5, "intents.near") },
});
report.steps.push({ populate_pending: opId });

const pre = {
  paused: await view(policyAcct, "get_paused"),
  epoch: await view(policyAcct, "get_mandate_epoch"),
  owner: await view(policyAcct, "get_owner"),
  agent: await view(policyAcct, "get_agent"),
  portfolio_id: await view(policyAcct, "get_portfolio_id"),
  derivation_path: await view(policyAcct, "get_derivation_path"),
  intents_signer_id: await view(policyAcct, "get_intents_signer_id"),
  verifying_contract: await view(policyAcct, "get_verifying_contract"),
  policy_hash: await view(policyAcct, "get_policy_hash"),
  autonomous_trading: await view(policyAcct, "get_autonomous_trading"),
  limits: await view(policyAcct, "get_limits"),
  daily_turnover: await view(policyAcct, "get_daily_turnover"),
  revocation: await view(policyAcct, "get_revocation_status"),
};
report.snapshots.pre_upgrade = pre;

// Confirm enforce method absent on OLD wasm
try {
  await view(policyAcct, "get_enforce_autonomous_on_agent");
  report.steps.push({ old_has_enforce: true });
} catch (e) {
  report.steps.push({
    old_has_enforce: false,
    note: String(e.message || e).slice(0, 120),
  });
}

// 2) Upgrade to NEW wasm (additive methods + raw storage only)
{
  let out;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      clearAccessKeyCache(policyAcct);
      const [, signed] = await policyAcct.signTransaction(policyId, [
        transactions.deployContract(newBuf),
      ]);
      out = await policyAcct.connection.provider.sendTransaction(signed);
      if (out.status?.Failure) throw new Error(JSON.stringify(out.status.Failure));
      break;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      if (/InvalidNonce|nonce/i.test(msg)) {
        clearAccessKeyCache(policyAcct);
        await sleep(500 + attempt * 250);
        continue;
      }
      report.upgrade_failure = msg.slice(0, 800);
      report.verdict = "NO_GO";
      report.error = "upgrade_tx_failed";
      writeFileSync(
        join(EVIDENCE, "J14_BORSH_UPGRADE_REHEARSAL.json"),
        JSON.stringify(report, null, 2)
      );
      process.exit(1);
    }
  }
  if (!out) {
    report.upgrade_failure = String(lastErr?.message || lastErr);
    report.verdict = "NO_GO";
    report.error = "upgrade_tx_failed";
    writeFileSync(
      join(EVIDENCE, "J14_BORSH_UPGRADE_REHEARSAL.json"),
      JSON.stringify(report, null, 2)
    );
    process.exit(1);
  }
  await sleep(600);
  report.steps.push({
    deploy_new: out.transaction.hash,
    explorer: `https://testnet.nearblocks.io/txns/${out.transaction.hash}`,
  });
}

let post;
try {
  post = {
    paused: await view(policyAcct, "get_paused"),
    epoch: await view(policyAcct, "get_mandate_epoch"),
    owner: await view(policyAcct, "get_owner"),
    agent: await view(policyAcct, "get_agent"),
    portfolio_id: await view(policyAcct, "get_portfolio_id"),
    derivation_path: await view(policyAcct, "get_derivation_path"),
    intents_signer_id: await view(policyAcct, "get_intents_signer_id"),
    verifying_contract: await view(policyAcct, "get_verifying_contract"),
    policy_hash: await view(policyAcct, "get_policy_hash"),
    autonomous_trading: await view(policyAcct, "get_autonomous_trading"),
    limits: await view(policyAcct, "get_limits"),
    daily_turnover: await view(policyAcct, "get_daily_turnover"),
    revocation: await view(policyAcct, "get_revocation_status"),
    enforce_autonomous_on_agent: await view(
      policyAcct,
      "get_enforce_autonomous_on_agent"
    ),
  };
} catch (e) {
  report.verdict = "NO_GO";
  report.error = `post_upgrade_view_failed:${String(e.message || e).slice(0, 400)}`;
  writeFileSync(
    join(EVIDENCE, "J14_BORSH_UPGRADE_REHEARSAL.json"),
    JSON.stringify(report, null, 2)
  );
  process.exit(1);
}
report.snapshots.post_upgrade = post;

const preserved = {
  owner: pre.owner === post.owner,
  agent: pre.agent === post.agent,
  portfolio_id: pre.portfolio_id === post.portfolio_id,
  derivation_path: pre.derivation_path === post.derivation_path,
  intents_signer_id: pre.intents_signer_id === post.intents_signer_id,
  verifying_contract: pre.verifying_contract === post.verifying_contract,
  policy_hash: pre.policy_hash === post.policy_hash,
  epoch: pre.epoch === post.epoch,
  paused: pre.paused === post.paused,
  autonomous_trading: pre.autonomous_trading === post.autonomous_trading,
  daily_turnover: String(pre.daily_turnover) === String(post.daily_turnover),
  limits_max_trade:
    String(pre.limits.max_trade_value) === String(post.limits.max_trade_value),
  limits_token_scope: pre.limits.token_scope === post.limits.token_scope,
  unresolved_pending:
    pre.revocation.unresolved_pending === post.revocation.unresolved_pending,
  enforce_default_false: post.enforce_autonomous_on_agent === false,
};
report.preserved = preserved;
report.preserved_all = Object.values(preserved).every(Boolean);

// 3) Idempotent migrate stamp (raw storage only)
const migrateOut = await callOnce(ownerAcct, policyId, {
  methodName: "migrate_state_v1_autonomy",
  args: {},
  gas: BigInt("30000000000000"),
});
report.steps.push({ migrate_state_v1_autonomy: migrateOut.transaction?.hash || "ok" });
const stateVersion = await view(policyAcct, "get_state_version");
report.state_version_after_migrate = stateVersion;

// 4) New activation method works without resetting custody identity
await callOnce(ownerAcct, policyId, {
  methodName: "activate_autonomous_mandate",
  args: {
    limits,
    policy_hash: "j14-post-upgrade-activate",
    strategy_hash: "j14-post-upgrade-strategy",
    enforce_autonomous_on_agent: true,
    autonomous_trading: true,
    unpause_now: true,
  },
});
const afterActivate = {
  enforce: await view(policyAcct, "get_enforce_autonomous_on_agent"),
  autonomous: await view(policyAcct, "get_autonomous_trading"),
  paused: await view(policyAcct, "get_paused"),
  epoch: await view(policyAcct, "get_mandate_epoch"),
  portfolio_id: await view(policyAcct, "get_portfolio_id"),
  intents_signer_id: await view(policyAcct, "get_intents_signer_id"),
};
report.snapshots.after_activate = afterActivate;
report.activate_ok =
  afterActivate.enforce === true &&
  afterActivate.autonomous === true &&
  afterActivate.paused === false &&
  afterActivate.portfolio_id === pre.portfolio_id &&
  afterActivate.intents_signer_id === pre.intents_signer_id;

report.verdict =
  report.old_matches_mainnet_artifact &&
  report.preserved_all &&
  report.activate_ok
    ? "PASS"
    : "NO_GO";
report.migration_model =
  "ADDITIVE_WASM_UPGRADE_NO_BORSH_REWRITE — PolicyContract/PolicyLimits/PendingOp layout unchanged vs deployed mainnet artifact; new autonomy methods use raw storage keys";
report.rollback =
  "Redeploy previous WASM bytes (3bc7c112…) if new methods misbehave; Borsh state remains readable by old code if layout unchanged. If layout ever diverges, DO NOT upgrade — require explicit migrate module.";
report.finished_at = new Date().toISOString();

writeFileSync(
  join(EVIDENCE, "J14_BORSH_UPGRADE_REHEARSAL.json"),
  JSON.stringify(report, null, 2)
);
console.log(
  JSON.stringify(
    {
      verdict: report.verdict,
      preserved_all: report.preserved_all,
      activate_ok: report.activate_ok,
      old_sha: report.old_wasm.sha256,
      new_sha: report.new_wasm.sha256,
      policy: policyId,
      evidence: join(EVIDENCE, "J14_BORSH_UPGRADE_REHEARSAL.json"),
    },
    null,
    2
  )
);
process.exit(report.verdict === "PASS" ? 0 : 1);
