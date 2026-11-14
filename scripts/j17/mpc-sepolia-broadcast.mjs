#!/usr/bin/env node
/**
 * J17.1/J17.2 — Authentic NEAR MPC → Sepolia ERC-20 transfer.
 *
 * Without J17_MPC_SIGN_BROADCAST_AUTHORIZED=1 → preflight / pre-sign check only.
 * Funding auth (J17_SEPOLIA_FUNDING_AUTHORIZED) alone does NOT unlock signing.
 * With auth + NIO_TX_JOURNAL_SECRET → propose_quoted_evm_transfer → persist pre-sign
 * intent → request_signature (1 yocto) → assemble → journal → broadcast once → settle.
 *
 * Never propose_trade fallback. Never blind retry/resign. ERC-20 ≠ Intents.
 * HARD STOP: no mainnet.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as nearAPI from "near-api-js";
import {
  NETWORK,
  MPC,
  pickRpc,
  assertNotDemo,
  SEPOLIA_RPC,
} from "../lib/near-live.mjs";
import { extractMpcSigFromNearTx } from "../../packages/gate-k/settle.mjs";
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
import { loadOrCreateAttestor } from "../../packages/services/attestor.mjs";
import { evmAddressFromNearSecpKey } from "../../packages/intents-codec/eip191.mjs";
import {
  SCENARIO_LABEL,
  CHAIN_ID,
  J16_POLICY,
  J16_MPC,
  USDC_SEPOLIA,
  TEST_RECIPIENT,
  AMOUNT_RAW,
  POLICY_VIEWS,
  assertProposeQuotedArgs,
  assertRequestSignatureArgs,
  refuseProposeTradeEvmFallback,
  buildDeterministicErc20Attestation,
  bindEip155DigestFromQuotedTx,
  validateQuotedTxAgainstAttestation,
  requireFreshGasEstimate,
  verifyPolicyViews,
  requireJournalSecret,
  requireMpcSignBroadcastAuth,
  persistPreSignIntent,
  loadPreSignIntent,
  verifyAttestorKeyCorrespondence,
  EXPECTED_ATTESTOR_PK,
  analyzePendingConflict,
  verifyOneTransferBoundary,
  AUTH_MPC_SIGN_BROADCAST,
} from "../../packages/autonomous/j17.sepoliaPath.mjs";

const { connect, keyStores, KeyPair, transactions } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const report = {
  kind: "J17_MPC_SEPOLIA_BROADCAST",
  baseline: "df3a84b",
  started_at: new Date().toISOString(),
  hard_stop_mainnet: true,
  scenario_label: SCENARIO_LABEL,
  intents_settlement: false,
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
async function nearView(rpc, accountId, methodName, args = {}) {
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
        account_id: accountId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) {
    throw new Error(JSON.stringify(j.error || j.result.error));
  }
  const raw = Buffer.from(j.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function clearAccessKeyCache(account) {
  if (account?.accessKeyByPublicKeyCache) account.accessKeyByPublicKeyCache = {};
}
async function callOnce(
  account,
  receiverId,
  { methodName, args, gas, deposit = 0n }
) {
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
      // NEAR access-key nonce only — never resign EVM / never new digest
      if (!/InvalidNonce|nonce too (low|high)/i.test(String(e.message || e))) {
        throw e;
      }
      clearAccessKeyCache(account);
      await sleep(400 + attempt * 200);
    }
  }
  throw lastErr;
}
async function erc20Balance(token, holder) {
  const data =
    "0x70a08231" +
    holder.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  return BigInt(
    (await eth("eth_call", [{ to: token, data }, "latest"])) || "0x0"
  );
}
function finish(code = 0) {
  report.finished_at = new Date().toISOString();
  const out = join(EVIDENCE, "J17_MPC_SEPOLIA_BROADCAST.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { verdict: report.verdict, gates: report.gates, evidence: out },
      null,
      2
    )
  );
  process.exit(code);
}

const authGate = requireMpcSignBroadcastAuth();
report.authorization = {
  [AUTH_MPC_SIGN_BROADCAST]: process.env[AUTH_MPC_SIGN_BROADCAST] === "1",
  J17_SEPOLIA_FUNDING_AUTHORIZED:
    process.env.J17_SEPOLIA_FUNDING_AUTHORIZED === "1",
  gate: authGate,
  note: "Funding confirmation ≠ MPC sign/broadcast approval. Quote-signer register is a separate auth.",
};

if (!authGate.ok) {
  report.verdict = "PRE_SIGN_CHECK_ONLY";
  const pre = spawnSync(
    process.execPath,
    [join(ROOT, "scripts/j17/mpc-sepolia-presign-check.mjs")],
    { cwd: ROOT, encoding: "utf8", env: process.env }
  );
  report.presign_exit = pre.status;
  try {
    report.presign = JSON.parse(
      readFileSync(join(EVIDENCE, "J17_2_PRE_SIGN_SAFETY.json"), "utf8")
    ).gates;
  } catch {
    report.presign = { error: "presign_evidence_missing" };
  }
  report.gates = {
    AUTHENTIC_MPC_TO_EVM_BROADCAST: "BLOCKED_NO_AUTH",
    PRE_SIGN: report.presign,
  };
  finish(0);
}

// -------- EXECUTE path (only with explicit J17_MPC_SIGN_BROADCAST_AUTHORIZED) --------
try {
  assertNotDemo();
  const journalOk = requireJournalSecret({ rootDir: ROOT, allowGenerate: false });
  if (!journalOk.ok) {
    report.verdict = "NO_GO";
    report.blocker = journalOk.reason;
    finish(1);
  }

  const nearRpc = await pickRpc();
  const views = {};
  for (const m of POLICY_VIEWS) views[m] = await nearView(nearRpc, J16_POLICY, m);
  const policyCheck = verifyPolicyViews(views);
  if (!policyCheck.ok) {
    report.verdict = "NO_GO";
    report.blocker = policyCheck.blockers;
    finish(1);
  }

  let pendingList = [];
  try {
    pendingList = await nearView(nearRpc, J16_POLICY, "list_pending");
  } catch {
    /* listed best-effort */
  }
  const pendingAnalysis = analyzePendingConflict({
    pendingList,
    reservedExposure: views.get_reserved_pending_exposure,
    maxPendingExposure: views.get_limits?.max_pending_exposure,
    nextAmount: AMOUNT_RAW,
    nextDestination: TEST_RECIPIENT,
  });
  report.pending_conflict = pendingAnalysis;
  if (!pendingAnalysis.ok) {
    report.verdict = "NO_GO";
    report.blocker = pendingAnalysis.blockers;
    finish(1);
  }

  const ethBal = BigInt(await eth("eth_getBalance", [J16_MPC, "latest"]));
  const tokenBal = await erc20Balance(USDC_SEPOLIA, J16_MPC);
  if (ethBal < 10n ** 16n || tokenBal < BigInt(AMOUNT_RAW)) {
    report.verdict = "NO_GO";
    report.blocker = "unfunded";
    finish(1);
  }

  const nonce = Number(
    BigInt(await eth("eth_getTransactionCount", [J16_MPC, "pending"]))
  );
  let gasPrice = BigInt(await eth("eth_gasPrice", []));
  if (gasPrice < 1_000_000_000n) gasPrice = 1_000_000_000n;

  const previewBind = bindEip155DigestFromQuotedTx({
    nonce,
    gasPrice: gasPrice.toString(),
    gasLimit: 300000,
    tokenContract: USDC_SEPOLIA,
    depositAddress: TEST_RECIPIENT,
    amount: AMOUNT_RAW,
  });
  let estHex = null;
  let estimateError = null;
  try {
    estHex = await eth("eth_estimateGas", [
      {
        from: J16_MPC,
        to: USDC_SEPOLIA,
        data: previewBind.data_hex,
        value: "0x0",
      },
    ]);
  } catch (e) {
    estimateError = e.message || e;
  }
  const fitted = requireFreshGasEstimate({
    estimateHexOrBigInt: estHex,
    estimateError,
    gasPrice,
    maxGasBudget: views.get_limits.max_gas_budget,
    usedHistoricalFallback: false,
  });
  if (!fitted.ok) {
    report.verdict = "NO_GO";
    report.blocker = fitted;
    finish(1);
  }

  const boundary = verifyOneTransferBoundary({
    chainId: CHAIN_ID,
    token: USDC_SEPOLIA,
    destination: TEST_RECIPIENT,
    amountRaw: AMOUNT_RAW,
    gasLimit: fitted.gas_limit,
    attemptedTransfers: 1,
  });
  if (!boundary.ok) {
    report.verdict = "NO_GO";
    report.blocker = boundary.blockers;
    finish(1);
  }

  const attestor = loadOrCreateAttestor(
    join(ROOT, ".gate-i-data", "attestor.seed.json")
  );
  const keyCheck = verifyAttestorKeyCorrespondence({
    secretKey64: attestor.secretKey64,
    storedPublicKey: attestor.publicKey,
    expectedPublicKey: EXPECTED_ATTESTOR_PK,
  });
  if (!keyCheck.ok) {
    report.verdict = "NO_GO";
    report.blocker = keyCheck;
    finish(1);
  }
  const trusted = await nearView(nearRpc, J16_POLICY, "is_trusted_quote_signer", {
    public_key: attestor.publicKey,
  });
  if (trusted !== true) {
    report.verdict = "NO_GO";
    report.blocker = "trusted_quote_signer_not_registered";
    finish(1);
  }

  const built = buildDeterministicErc20Attestation({
    secretKey64: attestor.secretKey64,
    depositAddress: TEST_RECIPIENT,
    tokenContract: USDC_SEPOLIA,
    amountIn: AMOUNT_RAW,
    recipient: TEST_RECIPIENT,
    refundTo: TEST_RECIPIENT,
    maxGasPrice: gasPrice.toString(),
    gasLimit: fitted.gas_limit,
  });
  const opId = `j17-exec-${randomBytes(3).toString("hex")}`;
  const preSignDir = join(ROOT, ".nio-secure", "j17", "presign");
  const existingIntent = loadPreSignIntent({ storeDir: preSignDir, operationId: opId });
  if (existingIntent.ok) {
    report.verdict = "NO_GO";
    report.blocker = {
      reason: "presign_intent_already_exists_for_new_op_id_unexpected",
      note: "Recovery must resume the existing operation_id — do not mint a parallel propose",
      path: existingIntent.path,
    };
    finish(1);
  }
  const tx = {
    nonce: String(nonce),
    gas_price: gasPrice.toString(),
    gas_limit: fitted.gas_limit,
    chain_id: String(CHAIN_ID),
    token_contract: USDC_SEPOLIA.toLowerCase(),
    to: TEST_RECIPIENT.toLowerCase(),
    amount: AMOUNT_RAW,
  };
  const bind = bindEip155DigestFromQuotedTx({
    nonce,
    gasPrice: tx.gas_price,
    gasLimit: tx.gas_limit,
    tokenContract: tx.token_contract,
    depositAddress: tx.to,
    amount: tx.amount,
  });
  const vAtt = validateQuotedTxAgainstAttestation({
    attestation: built.attestation,
    tx,
  });
  if (!vAtt.ok) {
    report.verdict = "NO_GO";
    report.blocker = vAtt.blockers;
    finish(1);
  }

  const proposeArgs = {
    operation_id: opId,
    attestation: built.attestation,
    attestation_signature: built.attestation_signature,
    signer_public_key: built.signer_public_key,
    tx,
    expected_epoch: views.get_mandate_epoch,
  };
  const pCheck = assertProposeQuotedArgs(proposeArgs);
  const rCheck = assertRequestSignatureArgs({ operation_id: opId });
  const tradeRefuse = refuseProposeTradeEvmFallback({
    destination: TEST_RECIPIENT,
  });
  if (!pCheck.ok || !rCheck.ok || tradeRefuse.action !== "REFUSE") {
    report.verdict = "NO_GO";
    report.blocker = { pCheck, rCheck, tradeRefuse };
    finish(1);
  }

  const ownerId = "nio-owner-02b7cf.testnet";
  const agentId = "nio-agent-02b7cf.testnet";
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey(NETWORK, ownerId, KeyPair.fromString(loadCred(ownerId).private_key));
  await ks.setKey(NETWORK, agentId, KeyPair.fromString(loadCred(agentId).private_key));
  const near = await connect({
    networkId: NETWORK,
    nodeUrl: nearRpc,
    deps: { keyStore: ks },
  });
  const agent = await near.account(agentId);

  const beforeSender = tokenBal;
  const beforeDest = await erc20Balance(USDC_SEPOLIA, TEST_RECIPIENT);

  // Single authorization method — no fallback
  let proposeOutcome;
  try {
    proposeOutcome = await callOnce(agent, J16_POLICY, {
      methodName: "propose_quoted_evm_transfer",
      args: proposeArgs,
      gas: BigInt("100000000000000"),
      deposit: 0n,
    });
  } catch (e) {
    report.verdict = "NO_GO";
    report.blocker = {
      propose_failed: String(e.message || e).slice(0, 500),
      note: "No propose_trade fallback — fix attestation/policy and retry as new operation",
    };
    finish(1);
  }
  report.propose = {
    tx: proposeOutcome.transaction.hash,
    explorer: `https://testnet.nearblocks.io/txns/${proposeOutcome.transaction.hash}`,
  };

  // Persist immutable pre-sign intent BEFORE MPC request_signature
  const preSign = persistPreSignIntent({
    storeDir: preSignDir,
    operationId: opId,
    epoch: views.get_mandate_epoch,
    amount: AMOUNT_RAW,
    destination: TEST_RECIPIENT,
    nonce,
    digestHex: bind.digest_hex,
    gasLimit: fitted.gas_limit,
    gasPrice: gasPrice.toString(),
    proposeNearTx: proposeOutcome.transaction.hash,
    status: "PRE_SIGN_LOCKED",
  });
  report.presign_intent = {
    path: preSign.path,
    resumed: preSign.resumed,
    operation_id: opId,
    digest_hex: bind.digest_hex,
  };
  if (!preSign.ok) {
    report.verdict = "NO_GO";
    report.blocker = preSign;
    finish(1);
  }
  if (preSign.resumed) {
    report.verdict = "NO_GO";
    report.blocker = {
      reason: "presign_intent_exists_recover_instead_of_duplicate_mpc",
      path: preSign.path,
    };
    finish(1);
  }

  let signOutcome;
  try {
    signOutcome = await callOnce(agent, J16_POLICY, {
      methodName: "request_signature",
      args: { operation_id: opId },
      gas: BigInt("300000000000000"),
      deposit: 1n, // 1 yoctoNEAR — ABI-required
    });
  } catch (e) {
    report.verdict = "NO_GO";
    report.blocker = {
      request_signature_failed: String(e.message || e).slice(0, 500),
      note: "No resign — quarantine; inspect pending via get_pending / resume presign intent",
      presign_path: preSign.path,
    };
    finish(1);
  }
  const nearTx = signOutcome.transaction.hash;
  report.mpc_request = {
    near_tx: nearTx,
    explorer: `https://testnet.nearblocks.io/txns/${nearTx}`,
  };

  await sleep(2500);
  const full = await near.connection.provider.txStatus(nearTx, agentId);
  const extracted = extractMpcSigFromNearTx(full);
  if (!extracted.found) {
    report.verdict = "UNKNOWN_NO_MPC_SIG";
    report.blocker = extracted.reason || "mpc_sig_missing";
    finish(0);
  }

  const assembled = assembleSignedEvmFromMpc({
    nearTxFull: full,
    nonce,
    gasPrice: tx.gas_price,
    gasLimit: tx.gas_limit,
    token: USDC_SEPOLIA,
    depositAddress: TEST_RECIPIENT,
    amount: AMOUNT_RAW,
    chainId: CHAIN_ID,
    expectedMpc: J16_MPC,
    expectedDigestHex: bind.digest_hex,
  });
  if (!assembled.ok) {
    report.verdict = "NO_GO";
    report.blocker = assembled;
    finish(1);
  }

  const vRaw = validateSignedRawAgainstPolicy({
    signedRawHex: assembled.rawHex,
    expected: {
      chainId: CHAIN_ID,
      nonce,
      token: USDC_SEPOLIA,
      mpc: J16_MPC,
      depositAddress: TEST_RECIPIENT,
      amount: AMOUNT_RAW,
      digestHex: bind.digest_hex,
    },
  });
  if (!vRaw.ok) {
    report.verdict = "NO_GO";
    report.blocker = vRaw;
    finish(1);
  }

  const journalPath = join(EVIDENCE, `j17-sepolia-journal-${opId}.sqlite`);
  await persistPreBroadcast({
    journalPath,
    operationId: opId,
    signedRaw: assembled.rawHex,
    nonce: String(nonce),
    decisionHash: bind.digest_hex,
    network: "sepolia",
    mode: EXEC_MODE.TESTNET,
  });

  let first;
  try {
    const txHash = await eth("eth_sendRawTransaction", [assembled.rawHex]);
    first = { tx_hash: txHash };
  } catch (e) {
    first = { error: String(e.message || e) };
  }
  const eval1 = evaluateBroadcastAttempt({
    priorState: TX_STATE.SIGNED,
    rpcResult: first.tx_hash ? first : null,
    transportError: first.error || null,
  });
  report.broadcast = { first, eval: eval1 };
  if (eval1.action === "UNKNOWN_QUARANTINE" || !first.tx_hash) {
    report.verdict = "UNKNOWN_NO_RESIGN";
    finish(0);
  }
  report.replay_protection = evaluateBroadcastAttempt({
    priorState: TX_STATE.BROADCAST,
    rpcResult: { tx_hash: first.tx_hash },
  });

  let receipt = null;
  for (let i = 0; i < 45; i++) {
    receipt = await eth("eth_getTransactionReceipt", [first.tx_hash]);
    if (receipt) break;
    await sleep(2000);
  }
  if (!receipt) {
    report.verdict = "UNKNOWN_NO_RECEIPT";
    finish(0);
  }
  receipt.from_node = true;
  receipt.label = "REAL_EVM_NODE";

  const afterSender = await erc20Balance(USDC_SEPOLIA, J16_MPC);
  const afterDest = await erc20Balance(USDC_SEPOLIA, TEST_RECIPIENT);
  const settle = verifySettlementFromReceipt({
    receipt,
    expected: {
      mpc: J16_MPC,
      token: USDC_SEPOLIA,
      depositAddress: TEST_RECIPIENT,
      amount: AMOUNT_RAW,
    },
    requireRealNode: true,
    balanceDelta: {
      beforeSender: beforeSender.toString(),
      afterSender: afterSender.toString(),
      beforeDest: beforeDest.toString(),
      afterDest: afterDest.toString(),
      amount: AMOUNT_RAW,
    },
  });
  report.settle = settle;
  report.explorer = `https://sepolia.etherscan.io/tx/${first.tx_hash}`;
  report.gates = {
    AUTHENTIC_MPC_TO_EVM_BROADCAST: "PASS",
    REAL_SEPOLIA_TOKEN_SETTLEMENT: settle.ok ? "PASS" : "FAIL",
    INDEPENDENT_RECONCILIATION:
      settle.independently_verified && settle.financial_readiness
        ? "PASS"
        : "FAIL",
    INTENTS_SETTLEMENT_VERIFIED: "NOT_APPLICABLE_ERC20_TRANSFER",
  };
  report.verdict = settle.ok ? "PASS" : "NO_GO";
  finish(settle.ok ? 0 : 1);
} catch (e) {
  report.verdict = "NO_GO";
  report.error = String(e.message || e).slice(0, 1200);
  finish(1);
}
