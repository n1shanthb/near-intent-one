#!/usr/bin/env node
/**
 * J17 — Authentic NEAR MPC → Sepolia ERC-20 transfer (post-funding only).
 *
 * Refuses unless:
 *   1) J17_SEPOLIA_FUNDING_AUTHORIZED=1
 *   2) Live Sepolia balances meet thresholds for MPC address + preferred token
 *
 * Never reuses an obsolete signature. Fresh nonce + gas + digest each attempt.
 * Broadcast at most once; ambiguous → UNKNOWN, no resign.
 * HARD STOP: no mainnet. This prompt alone does not authorize funding.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import * as nearAPI from "near-api-js";
import {
  NETWORK,
  MPC,
  pickRpc,
  assertNotDemo,
  SEPOLIA_RPC,
  USDC_SEPOLIA,
} from "../lib/near-live.mjs";
import {
  extractMpcSigFromNearTx,
  mpcToRsV,
  recoverFromHash,
} from "../../packages/gate-k/settle.mjs";
import {
  assembleSignedEvmFromMpc,
  validateSignedRawAgainstPolicy,
  verifySettlementFromReceipt,
  TX_STATE,
} from "../../packages/autonomous/signedTxPipeline.mjs";
import {
  evaluateBroadcastAttempt,
  persistPreBroadcast,
  EXEC_MODE,
} from "../../packages/autonomous/executorAdapter.mjs";
import {
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
} from "../../packages/intents-codec/quote-auth.mjs";
import { evmAddressFromNearSecpKey } from "../../packages/intents-codec/eip191.mjs";

const { connect, keyStores, KeyPair, transactions } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const J16_MPC = "0x9a82c26b3d158cf4b657ab2a3ef9e5e6c2934d55";
const J16_PATH = "trading/v1/portfolio/j16-mpc-6890";
const J16_PREDECESSOR = "j16f6890.testnet";
const DEST = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"; // labeled test recipient
const AMOUNT = "1000000";
const MIN_ETH_WEI = 10n ** 16n;
const MIN_TOKEN_RAW = 1_000_000n;
const GAS_LIMIT = 100000n;

const report = {
  kind: "J17_MPC_SEPOLIA_BROADCAST",
  baseline: "ed2bd79",
  started_at: new Date().toISOString(),
  hard_stop_mainnet: true,
  scenario_label: "DETERMINISTIC_TESTNET_ERC20_TRANSFER_NOT_INTENTS",
  intents_testnet: "NOT_AVAILABLE",
};

function loadCred(id) {
  return JSON.parse(readFileSync(join(CREDS, `${id}.json`), "utf8"));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function eth(method, params = []) {
  const res = await fetch(SEPOLIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function erc20Balance(token, holder) {
  const data =
    "0x70a08231" +
    holder.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  return BigInt((await eth("eth_call", [{ to: token, data }, "latest"])) || "0x0");
}

async function deriveMpcEvm({ rpc, policyId, path }) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: MPC,
        method_name: "derived_public_key",
        args_base64: Buffer.from(
          JSON.stringify({ path, predecessor: policyId, domain_id: 0 })
        ).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) {
    throw new Error(JSON.stringify(j.error || j.result.error));
  }
  const raw = Buffer.from(j.result.result).toString("utf8");
  let key;
  try {
    key = JSON.parse(raw);
  } catch {
    key = raw.replace(/^"|"$/g, "");
  }
  if (typeof key === "object") key = key.public_key || key;
  return {
    near_secp_key: key,
    evm_address: evmAddressFromNearSecpKey(String(key)).toLowerCase(),
    path,
    predecessor: policyId,
  };
}

function clearAccessKeyCache(account) {
  if (account?.accessKeyByPublicKeyCache) account.accessKeyByPublicKeyCache = {};
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
      await sleep(300);
      return outcome;
    } catch (e) {
      lastErr = e;
      if (!/InvalidNonce|nonce/i.test(String(e.message || e))) throw e;
      clearAccessKeyCache(account);
      await sleep(400 + attempt * 200);
    }
  }
  throw lastErr;
}

function finish(code = 0) {
  report.finished_at = new Date().toISOString();
  const out = join(EVIDENCE, "J17_MPC_SEPOLIA_BROADCAST.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdict: report.verdict, gates: report.gates, evidence: out }, null, 2));
  process.exit(code);
}

// --- Gate 0: funding authorization boundary ---
const authorized = process.env.J17_SEPOLIA_FUNDING_AUTHORIZED === "1";
report.authorization = {
  J17_SEPOLIA_FUNDING_AUTHORIZED: authorized,
  note: "Explicit env auth required; mission text alone is not authorization.",
};

if (!authorized) {
  report.verdict = "STOP_AT_FUNDING_AUTHORIZATION_BOUNDARY";
  report.gates = {
    SEPOLIA_FUNDING_CONFIRMED: "NOT_CHECKED_AUTH_MISSING",
    AUTHENTIC_MPC_TO_EVM_BROADCAST: "BLOCKED_NO_AUTH",
    REAL_SEPOLIA_TOKEN_SETTLEMENT: "BLOCKED_NO_AUTH",
    INDEPENDENT_RECONCILIATION: "BLOCKED_NO_AUTH",
  };
  report.blocker =
    "Set J17_SEPOLIA_FUNDING_AUTHORIZED=1 only after separate owner funding authorization AND confirmed Sepolia balances.";
  finish(0);
}

try {
  assertNotDemo();
  const nearRpc = await pickRpc();
  const chainId = Number(BigInt(await eth("eth_chainId", [])));
  if (chainId !== 11155111) throw new Error(`bad_chain_${chainId}`);

  const derived = await deriveMpcEvm({
    rpc: nearRpc,
    policyId: J16_PREDECESSOR,
    path: J16_PATH,
  });
  if (derived.evm_address !== J16_MPC.toLowerCase()) {
    throw new Error(`derived_mismatch_${derived.evm_address}`);
  }

  const ethBal = BigInt(await eth("eth_getBalance", [J16_MPC, "latest"]));
  const tokenBal = await erc20Balance(USDC_SEPOLIA, J16_MPC);
  const nonce = Number(
    BigInt(await eth("eth_getTransactionCount", [J16_MPC, "pending"]))
  );
  report.preflight = {
    mpc: J16_MPC,
    eth_wei: ethBal.toString(),
    token: USDC_SEPOLIA.toLowerCase(),
    token_raw: tokenBal.toString(),
    nonce,
  };

  if (ethBal < MIN_ETH_WEI || tokenBal < MIN_TOKEN_RAW) {
    report.verdict = "STOP_UNFUNDED";
    report.gates = {
      SEPOLIA_FUNDING_CONFIRMED: "FAIL",
      AUTHENTIC_MPC_TO_EVM_BROADCAST: "BLOCKED_UNFUNDED",
      REAL_SEPOLIA_TOKEN_SETTLEMENT: "BLOCKED_UNFUNDED",
      INDEPENDENT_RECONCILIATION: "BLOCKED_UNFUNDED",
    };
    report.blocker = "Balances below thresholds despite auth env — re-run funding boundary.";
    finish(0);
  }

  report.gates = { SEPOLIA_FUNDING_CONFIRMED: "PASS" };

  // Fresh fee + digest — never reuse prior signature
  const gasPrice = BigInt(await eth("eth_gasPrice", []));
  const data = erc20TransferData(DEST, AMOUNT);
  const digestBytes = eip155UnsignedDigest({
    nonce: BigInt(nonce),
    gasPrice,
    gasLimit: GAS_LIMIT,
    to: USDC_SEPOLIA,
    data,
    chainId: 11155111,
  });
  const digest_hex = digestHex(digestBytes);
  report.fresh_tx = {
    nonce,
    gasPrice: gasPrice.toString(),
    gasLimit: GAS_LIMIT.toString(),
    token: USDC_SEPOLIA.toLowerCase(),
    dest: DEST,
    amount: AMOUNT,
    digest_hex,
    note: "Fresh nonce/fees/digest — obsolete signatures must not be reused",
  };

  // NEAR accounts from J16 evidence
  const ownerId = "nio-owner-02b7cf.testnet";
  const agentId = "nio-agent-02b7cf.testnet";
  const policyId = J16_PREDECESSOR;
  if (!existsSync(join(CREDS, `${ownerId}.json`)) || !existsSync(join(CREDS, `${agentId}.json`))) {
    report.verdict = "NO_GO";
    report.blocker = "missing_testnet_credentials";
    finish(1);
  }

  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey(NETWORK, ownerId, KeyPair.fromString(loadCred(ownerId).private_key));
  await ks.setKey(NETWORK, agentId, KeyPair.fromString(loadCred(agentId).private_key));
  // policy may use agent as signer for propose; load if present
  if (existsSync(join(CREDS, `${policyId}.json`))) {
    await ks.setKey(
      NETWORK,
      policyId,
      KeyPair.fromString(loadCred(policyId).private_key)
    );
  }

  const near = await connect({
    networkId: NETWORK,
    nodeUrl: nearRpc,
    deps: { keyStore: ks },
  });
  const agent = await near.account(agentId);
  const owner = await near.account(ownerId);

  // Pause/revoke check before spending
  let viewState;
  try {
    const raw = await near.connection.provider.query({
      request_type: "call_function",
      account_id: policyId,
      method_name: "get_state",
      args_base64: Buffer.from("{}").toString("base64"),
      finality: "final",
    });
    viewState = JSON.parse(Buffer.from(raw.result).toString("utf8"));
  } catch {
    viewState = null;
  }
  report.on_chain_policy = {
    paused: viewState?.paused ?? null,
    autonomous_trading: viewState?.autonomous_trading ?? null,
  };
  if (viewState?.paused === true) {
    report.verdict = "REFUSED_PAUSED";
    report.gates.AUTHENTIC_MPC_TO_EVM_BROADCAST = "REFUSED_PAUSED";
    finish(0);
  }

  const beforeSender = tokenBal;
  const beforeDest = await erc20Balance(USDC_SEPOLIA, DEST);

  // Prefer propose_quoted_evm_transfer when available
  const opId = `j17-${randomBytes(4).toString("hex")}`;
  let proposeOutcome;
  try {
    proposeOutcome = await callOnce(agent, policyId, {
      methodName: "propose_quoted_evm_transfer",
      args: {
        operation_id: opId,
        chain_id: 11155111,
        token: USDC_SEPOLIA.toLowerCase(),
        destination: DEST.toLowerCase(),
        amount: AMOUNT,
        digest_hex,
        nonce,
        gas_price: gasPrice.toString(),
        gas_limit: GAS_LIMIT.toString(),
      },
      gas: BigInt("80000000000000"),
    });
  } catch (e) {
    // Fall back to propose_trade + request_signature path used in J16 if quoted method missing
    report.propose_quoted_error = String(e.message || e).slice(0, 400);
    proposeOutcome = await callOnce(agent, policyId, {
      methodName: "propose_trade",
      args: {
        operation_id: opId,
        size_raw: AMOUNT,
        destination: DEST.toLowerCase(),
        asset: `eip155:11155111:${USDC_SEPOLIA.toLowerCase()}`,
      },
      gas: BigInt("80000000000000"),
    });
  }
  report.propose = {
    tx: proposeOutcome.transaction.hash,
    explorer: `https://testnet.nearblocks.io/txns/${proposeOutcome.transaction.hash}`,
  };

  const signOutcome = await callOnce(agent, policyId, {
    methodName: "request_signature",
    args: {
      operation_id: opId,
      path: J16_PATH,
      payload: digest_hex,
      domain_id: 0,
    },
    gas: BigInt("300000000000000"),
  });
  const nearTx = signOutcome.transaction.hash;
  report.mpc_request = {
    near_tx: nearTx,
    explorer: `https://testnet.nearblocks.io/txns/${nearTx}`,
  };

  await sleep(2000);
  const full = await near.connection.provider.txStatus(nearTx, agentId);
  const extracted = extractMpcSigFromNearTx(full);
  report.mpc_extract = {
    found: extracted.found,
    reason: extracted.reason || null,
  };
  if (!extracted.found) {
    report.verdict = "NO_GO";
    report.gates.AUTHENTIC_MPC_TO_EVM_BROADCAST = "FAIL_NO_MPC_SIG";
    report.blocker = extracted.reason || "mpc_sig_missing";
    finish(1);
  }

  const assembled = assembleSignedEvmFromMpc({
    nearTxFull: full,
    nonce,
    gasPrice: gasPrice.toString(),
    gasLimit: GAS_LIMIT.toString(),
    token: USDC_SEPOLIA,
    depositAddress: DEST,
    amount: AMOUNT,
    chainId: 11155111,
    expectedMpc: J16_MPC,
    expectedDigestHex: digest_hex,
  });
  report.assemble = { ok: assembled.ok, reason: assembled.reason || null };
  if (!assembled.ok) {
    report.verdict = "NO_GO";
    report.gates.AUTHENTIC_MPC_TO_EVM_BROADCAST = "FAIL_ASSEMBLE";
    finish(1);
  }

  const recovered = assembled.recovered || assembled.from;
  if (String(recovered).toLowerCase() !== J16_MPC.toLowerCase()) {
    report.verdict = "NO_GO";
    report.gates.AUTHENTIC_MPC_TO_EVM_BROADCAST = "FAIL_RECOVER_MISMATCH";
    report.recovered = recovered;
    finish(1);
  }

  const v = validateSignedRawAgainstPolicy({
    signedRawHex: assembled.rawHex,
    expected: {
      chainId: 11155111,
      nonce,
      token: USDC_SEPOLIA,
      mpc: J16_MPC,
      depositAddress: DEST,
      amount: AMOUNT,
      digestHex: digest_hex,
    },
  });
  report.validate = v;
  if (!v.ok) {
    report.verdict = "NO_GO";
    report.gates.AUTHENTIC_MPC_TO_EVM_BROADCAST = "FAIL_POLICY_VALIDATE";
    finish(1);
  }

  if (!process.env.NIO_TX_JOURNAL_SECRET) {
    process.env.NIO_TX_JOURNAL_SECRET = createHash("sha256")
      .update(`j17-${opId}`)
      .digest("hex");
  }
  const journalPath = join(EVIDENCE, `j17-sepolia-journal-${opId}.sqlite`);
  const persisted = await persistPreBroadcast({
    journalPath,
    operationId: opId,
    signedRaw: assembled.rawHex,
    nonce: String(nonce),
    decisionHash: digest_hex,
    network: "sepolia",
    mode: EXEC_MODE.TESTNET,
  });
  report.journal = { ok: persisted?.ok, path: journalPath };

  // Broadcast at most once
  const broadcastOnce = async (raw) => {
    try {
      const txHash = await eth("eth_sendRawTransaction", [raw]);
      return { tx_hash: txHash };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  };

  const first = await broadcastOnce(assembled.rawHex);
  const eval1 = evaluateBroadcastAttempt({
    priorState: TX_STATE.SIGNED,
    rpcResult: first.tx_hash ? first : null,
    transportError: first.error || null,
  });
  report.broadcast = { first, eval: eval1 };
  if (eval1.action === "UNKNOWN_QUARANTINE") {
    report.verdict = "UNKNOWN_NO_RESIGN";
    report.gates.AUTHENTIC_MPC_TO_EVM_BROADCAST = "UNKNOWN_QUARANTINE";
    finish(0);
  }
  if (!first.tx_hash) {
    report.verdict = "NO_GO";
    report.gates.AUTHENTIC_MPC_TO_EVM_BROADCAST = "FAIL_BROADCAST";
    finish(1);
  }

  // Refuse second broadcast / resign
  const replayEval = evaluateBroadcastAttempt({
    priorState: TX_STATE.BROADCAST,
    rpcResult: { tx_hash: first.tx_hash },
  });
  report.replay_protection = {
    second_broadcast_action: replayEval.action,
    may_resign: replayEval.may_resign === false,
  };

  // Wait for receipt
  let receipt = null;
  for (let i = 0; i < 45; i++) {
    receipt = await eth("eth_getTransactionReceipt", [first.tx_hash]);
    if (receipt) break;
    await sleep(2000);
  }
  if (!receipt) {
    report.verdict = "UNKNOWN_NO_RECEIPT";
    report.gates.AUTHENTIC_MPC_TO_EVM_BROADCAST = "PASS_BROADCAST";
    report.gates.REAL_SEPOLIA_TOKEN_SETTLEMENT = "UNKNOWN_NO_RECEIPT";
    finish(0);
  }

  receipt.from_node = true;
  receipt.label = "REAL_EVM_NODE";

  const afterSender = await erc20Balance(USDC_SEPOLIA, J16_MPC);
  const afterDest = await erc20Balance(USDC_SEPOLIA, DEST);
  const settle = verifySettlementFromReceipt({
    receipt,
    expected: {
      mpc: J16_MPC,
      token: USDC_SEPOLIA,
      depositAddress: DEST,
      amount: AMOUNT,
    },
    requireRealNode: true,
    balanceDelta: {
      beforeSender: beforeSender.toString(),
      afterSender: afterSender.toString(),
      beforeDest: beforeDest.toString(),
      afterDest: afterDest.toString(),
      amount: AMOUNT,
    },
  });

  report.settle = settle;
  report.balances = {
    beforeSender: beforeSender.toString(),
    afterSender: afterSender.toString(),
    beforeDest: beforeDest.toString(),
    afterDest: afterDest.toString(),
  };
  report.explorer = `https://sepolia.etherscan.io/tx/${first.tx_hash}`;

  report.gates.AUTHENTIC_MPC_TO_EVM_BROADCAST = "PASS";
  report.gates.REAL_SEPOLIA_TOKEN_SETTLEMENT = settle.ok ? "PASS" : "FAIL";
  report.gates.INDEPENDENT_RECONCILIATION =
    settle.independently_verified && settle.financial_readiness
      ? "PASS"
      : "FAIL";
  report.verdict = settle.ok ? "PASS" : "NO_GO";
  finish(settle.ok ? 0 : 1);
} catch (e) {
  report.verdict = "NO_GO";
  report.error = String(e.message || e).slice(0, 1200);
  report.gates = {
    ...(report.gates || {}),
    AUTHENTIC_MPC_TO_EVM_BROADCAST: "FAIL",
    REAL_SEPOLIA_TOKEN_SETTLEMENT: "NO-GO",
    INDEPENDENT_RECONCILIATION: "NO-GO",
  };
  finish(1);
}
