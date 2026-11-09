#!/usr/bin/env node
/**
 * Live Gate B orchestrator (NEAR testnet only).
 * Deploy → propose → request_signature (MPC) → verify → revoke → prove block
 * → receipt signature leak check → fabricated settlement check → path analysis notes.
 *
 * Manual Ledger confirmation: NONE for this script (uses faucet-created software keys).
 * Ledger is required later for production owner high-authority ops only.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import * as nearAPI from "near-api-js";
import bs58 from "bs58";

const { connect, keyStores, utils, transactions } = nearAPI;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE_DIR = join(ROOT, "evidence", "live");
const MPC = "v1.signer-prod.testnet";
const RPC = "https://rpc.testnet.near.org";
const NETWORK = "testnet";

mkdirSync(EVIDENCE_DIR, { recursive: true });

function loadWallets() {
  const path = join(EVIDENCE_DIR, "wallets.json");
  if (!existsSync(path)) throw new Error("missing evidence/live/wallets.json — run create-testnet-wallets.mjs");
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadCred(accountId) {
  return JSON.parse(readFileSync(join(CREDS, `${accountId}.json`), "utf8"));
}

function findWasm() {
  const candidates = [
    join(ROOT, "contracts", "policy", "target", "wasm32-unknown-unknown", "release", "policy.wasm"),
    join(ROOT, "contracts", "policy", "target", "wasm32-unknown-unknown", "release", "policy_contract.wasm"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("policy.wasm not found — run cargo build --target wasm32-unknown-unknown --release");
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "gate-b", method, params }),
  });
  return res.json();
}

async function viewFunction(accountId, methodName, args = {}) {
  const json = await rpc("query", {
    request_type: "call_function",
    finality: finality(),
    account_id: accountId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (json.error) throw new Error(JSON.stringify(json.error));
  const raw = Buffer.from(json.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function finality() {
  return "final";
}

async function txStatus(txHash, accountId) {
  // experimental tx status with receipts
  return rpc("tx", [txHash, accountId]);
}

async function txStatusReceipts(txHash, sender) {
  return rpc("EXPERIMENTAL_tx_status", [txHash, sender]);
}

/** Poll until FINAL or timeout (MPC sign can take minutes / ~200 blocks). */
async function waitFinal(txHash, sender, { timeoutMs = 600_000, intervalMs = 5_000 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await txStatusReceipts(txHash, sender);
    const status = last?.result?.final_execution_status || last?.result?.status;
    const exec = last?.result?.status;
    const failed = exec?.Failure || last?.error;
    if (failed) return last;
    if (
      last?.result?.final_execution_status === "FINAL" ||
      (exec?.SuccessValue !== undefined && last?.result?.receipts_outcome?.length)
    ) {
      // Prefer true FINAL for MPC; if SuccessValue present and no pending, accept after short settle
      if (last?.result?.final_execution_status === "FINAL") return last;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

function hex32() {
  return randomBytes(32).toString("hex");
}

function commitmentForOp(opId, epoch) {
  return createHash("sha256").update(`${opId}|${epoch}|gate-b`).digest("hex");
}

/** Derive secp256k1 uncompressed/compressed pubkey via MPC derived_public_key if available. */
async function derivedPublicKey(predecessor, path, domainId = 0) {
  try {
    return await viewFunction(MPC, "derived_public_key", {
      path,
      predecessor,
      domain_id: domainId,
    });
  } catch (e) {
    return { error: String(e) };
  }
}

async function mpcRootPublicKey() {
  try {
    return await viewFunction(MPC, "public_key");
  } catch (e) {
    return { error: String(e) };
  }
}

function save(name, obj) {
  const p = join(EVIDENCE_DIR, name);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  console.log(`wrote ${p}`);
  return p;
}

async function main() {
  const evidence = {
    started_at: new Date().toISOString(),
    network: NETWORK,
    mpc_signer: MPC,
    ledger_manual_confirmation_required: "NONE for Gate B (software faucet keys). Ledger required later for production owner set_policy/pause/revoke/withdraw only.",
    steps: {},
    gates: {},
  };

  const wallets = loadWallets();
  const ownerId = wallets.accounts.owner.account_id;
  const agentId = wallets.accounts.agent.account_id;
  const contractId = wallets.accounts.contract.account_id;
  evidence.accounts = { ownerId, agentId, contractId };

  const keyStore = new keyStores.InMemoryKeyStore();
  for (const role of ["owner", "agent", "contract"]) {
    const id = wallets.accounts[role].account_id;
    const cred = loadCred(id);
    const kp = nearAPI.KeyPair.fromString(cred.private_key);
    await keyStore.setKey(NETWORK, id, kp);
  }

  const near = await connect({
    networkId: NETWORK,
    nodeUrl: RPC,
    deps: { keyStore },
  });

  const owner = await near.account(ownerId);
  const agent = await near.account(agentId);
  const contractAccount = await near.account(contractId);

  // ── 0. MPC root key (live query) ──────────────────────────────────────
  const rootPk = await mpcRootPublicKey();
  evidence.steps.mpc_public_key = { signer: MPC, public_key: rootPk };
  save("01-mpc-public-key.json", evidence.steps.mpc_public_key);

  // ── 1. Deploy ─────────────────────────────────────────────────────────
  const wasmPath = findWasm();
  const wasm = readFileSync(wasmPath);
  console.log(`deploying ${wasmPath} (${wasm.length} bytes) → ${contractId}`);
  let deployResult;
  try {
    deployResult = await contractAccount.deployContract(wasm);
  } catch (e) {
    evidence.steps.deploy = { ok: false, error: String(e) };
    save("gate-b-evidence.json", evidence);
    throw e;
  }
  evidence.steps.deploy = {
    ok: true,
    contract_id: contractId,
    wasm_bytes: wasm.length,
    transaction_hash: deployResult.transaction.hash,
    status: deployResult.status,
  };
  save("02-deploy.json", evidence.steps.deploy);

  // ── 2. Init ───────────────────────────────────────────────────────────
  // U64 JSON strings — NEAR block timestamps are nanoseconds (exceed JS safe integer).
  const validUntilNs = "1893456000000000000"; // ~2030-01-01 ns

  let initResult;
  try {
    initResult = await contractAccount.functionCall({
      contractId,
      methodName: "new",
      args: {
        owner: ownerId,
        agent: agentId,
        mpc_signer: MPC,
        limits: {
          max_trade_value: "25",
          daily_turnover_limit: "100",
          max_pending_exposure: "25",
          max_slippage_bps: 100,
          allowed_assets: ["USDC", "NEAR", "ETH"],
          allowed_destinations: ["intents.near"],
          valid_until: validUntilNs,
        },
      },
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
  } catch (e) {
    // maybe already initialized — record and continue if views work
    evidence.steps.init = { ok: false, error: String(e) };
    save("03-init.json", evidence.steps.init);
  }
  if (initResult) {
    evidence.steps.init = {
      ok: true,
      transaction_hash: initResult.transaction.hash,
      status: initResult.status,
    };
    save("03-init.json", evidence.steps.init);
  }

  const epoch = await viewFunction(contractId, "get_mandate_epoch");
  const path = await viewFunction(contractId, "get_derivation_path");
  evidence.steps.views_after_init = { epoch, path, owner: await viewFunction(contractId, "get_owner"), agent: await viewFunction(contractId, "get_agent") };
  save("04-views-after-init.json", evidence.steps.views_after_init);

  const derived = await derivedPublicKey(contractId, path, 0);
  evidence.steps.derived_public_key = { predecessor: contractId, path, domain_id: 0, result: derived };
  save("05-derived-public-key.json", evidence.steps.derived_public_key);

  // ── 3. propose_trade ──────────────────────────────────────────────────
  const operationId = `op-gateb-${Date.now()}`;
  const payloadCommitment = commitmentForOp(operationId, epoch);
  const intentDeadline = validUntilNs; // far future for test
  let proposeResult;
  try {
    proposeResult = await agent.functionCall({
      contractId,
      methodName: "propose_trade",
      args: {
        proposal: {
          operation_id: operationId,
          amount_in: "10",
          asset_in: "USDC",
          asset_out: "NEAR",
          destination: "intents.near",
          min_amount_out: "9",
          intent_deadline: intentDeadline,
          payload_commitment: payloadCommitment,
        },
      },
      gas: BigInt("100000000000000"),
      attachedDeposit: 0n,
    });
    evidence.steps.propose_trade = {
      ok: true,
      operation_id: operationId,
      transaction_hash: proposeResult.transaction.hash,
      logs: proposeResult.receipts_outcome?.flatMap((r) => r.outcome.logs) ?? [],
    };
  } catch (e) {
    evidence.steps.propose_trade = { ok: false, error: String(e) };
    save("gate-b-evidence.json", evidence);
    throw e;
  }
  save("06-propose-trade.json", evidence.steps.propose_trade);

  // ── 4. request_signature (LIVE MPC) ───────────────────────────────────
  let signResult;
  let signError = null;
  try {
    signResult = await agent.functionCall({
      contractId,
      methodName: "request_signature",
      args: { operation_id: operationId },
      gas: BigInt("300000000000000"), // 300 Tgas — MPC needs headroom
      attachedDeposit: 1n, // 1 yoctoNEAR
    });
  } catch (e) {
    signError = String(e);
  }

  const signTxHash = signResult?.transaction?.hash ?? extractTxHash(signError);
  evidence.steps.request_signature = {
    ok: !!signResult && !signError,
    operation_id: operationId,
    transaction_hash: signTxHash,
    error: signError,
    status: signResult?.status ?? null,
    logs: signResult?.receipts_outcome?.flatMap((r) => r.outcome.logs) ?? [],
    receipts_outcome_summary: summarizeReceipts(signResult),
  };
  save("07-request-signature.json", evidence.steps.request_signature);

  // Fetch full experimental tx status for signature extraction analysis
  let fullTx = null;
  if (signTxHash) {
    fullTx = await txStatusReceipts(signTxHash, agentId);
    save("08-request-signature-full-tx.json", fullTx);
    evidence.steps.signature_from_receipts = extractSignatureFromTx(fullTx);
    save("09-signature-extraction.json", evidence.steps.signature_from_receipts);
  }

  // Pending state after sign attempt
  const pendingAfter = await viewFunction(contractId, "get_pending", { operation_id: operationId });
  evidence.steps.pending_after_sign = pendingAfter;
  save("10-pending-after-sign.json", pendingAfter);

  // Independent verification: if we have secp256k1 signature components + payload + derived key
  evidence.steps.independent_verification = await independentlyVerify({
    payloadCommitment,
    signatureExtraction: evidence.steps.signature_from_receipts,
    derived,
    rootPk,
  });
  save("11-independent-verification.json", evidence.steps.independent_verification);

  // Gate B pass criteria (live MPC signature obtained)
  const gateBPass =
    evidence.steps.request_signature.ok &&
    evidence.steps.signature_from_receipts?.found === true &&
    (evidence.steps.independent_verification?.verified === true ||
      evidence.steps.independent_verification?.verified === "partial");

  evidence.gates.B_contract_controlled_mpc = {
    status: gateBPass ? "PASS" : evidence.steps.request_signature.ok ? "BLOCKED" : "FAIL",
    reason: gateBPass
      ? "Live MPC signature observed in execution receipts and verification attempted"
      : evidence.steps.request_signature.error ||
        "MPC call did not yield extractable signature in receipts",
  };

  // ── 5. Revoke ─────────────────────────────────────────────────────────
  let revokeResult;
  try {
    revokeResult = await owner.functionCall({
      contractId,
      methodName: "revoke",
      args: {},
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
    evidence.steps.revoke = {
      ok: true,
      transaction_hash: revokeResult.transaction.hash,
      logs: revokeResult.receipts_outcome?.flatMap((r) => r.outcome.logs) ?? [],
    };
  } catch (e) {
    evidence.steps.revoke = { ok: false, error: String(e) };
  }
  save("12-revoke.json", evidence.steps.revoke);

  const revStatus = await viewFunction(contractId, "get_revocation_status");
  evidence.steps.revocation_status = revStatus;
  save("13-revocation-status.json", revStatus);

  // ── 6. Post-revoke signing must fail ──────────────────────────────────
  const operationId2 = `op-gateb-postrevoke-${Date.now()}`;
  let postProposeErr = null;
  let postProposeOk = false;
  try {
    await agent.functionCall({
      contractId,
      methodName: "propose_trade",
      args: {
        proposal: {
          operation_id: operationId2,
          amount_in: "5",
          asset_in: "USDC",
          asset_out: "NEAR",
          destination: "intents.near",
          min_amount_out: "4",
          intent_deadline: intentDeadline,
          payload_commitment: hex32(),
        },
      },
      gas: BigInt("100000000000000"),
      attachedDeposit: 0n,
    });
    postProposeOk = true;
  } catch (e) {
    postProposeErr = String(e);
  }
  evidence.steps.post_revoke_propose = {
    ok: postProposeOk,
    expected_fail: true,
    error: postProposeErr,
    blocked: !postProposeOk && /revoked/i.test(postProposeErr || ""),
  };
  save("14-post-revoke-propose.json", evidence.steps.post_revoke_propose);

  // Also try request_signature on original op if still Reserved/Signing
  let postSignErr = null;
  let postSignOk = false;
  try {
    await agent.functionCall({
      contractId,
      methodName: "request_signature",
      args: { operation_id: operationId },
      gas: BigInt("100000000000000"),
      attachedDeposit: 1n,
    });
    postSignOk = true;
  } catch (e) {
    postSignErr = String(e);
  }
  evidence.steps.post_revoke_request_signature = {
    ok: postSignOk,
    expected_fail: true,
    error: postSignErr,
    blocked: !postSignOk && /revoked|paused|Reserved|Signing|stale/i.test(postSignErr || ""),
  };
  save("15-post-revoke-request-signature.json", evidence.steps.post_revoke_request_signature);

  evidence.gates.B_revoke_blocks_new_signing = {
    status:
      evidence.steps.post_revoke_propose.blocked || evidence.steps.post_revoke_request_signature.blocked
        ? "PASS"
        : "FAIL",
    propose_blocked: evidence.steps.post_revoke_propose.blocked,
    request_signature_blocked: evidence.steps.post_revoke_request_signature.blocked,
  };

  // ── 7. Pre-revoke signature extractability ────────────────────────────
  evidence.steps.pre_revoke_signature_public_extractability = {
    analysis:
      "NEAR receipt outcomes include SuccessValue for completed cross-contract calls. If MPC sign succeeded before revoke callback logic ran, the secp256k1 signature may appear in a receipt SuccessValue even when on_signature refuses to treat it as submittable authority. Revocation cannot cryptographically erase an already-published signature from chain history.",
    found_in_receipts: evidence.steps.signature_from_receipts?.found ?? false,
    implication:
      evidence.steps.signature_from_receipts?.found
        ? "A pre-revoke signature IS extractable from public receipts. Treat revoke as blocking NEW authority + quarantining pending exposure, not as invalidating published signatures."
        : "No signature found in receipts for this run (MPC may have timed out/failed). Extractability remains a design risk when MPC succeeds.",
  };
  save("16-sig-extractability.md.json", evidence.steps.pre_revoke_signature_public_extractability);

  // ── 8. Path / custody identity ────────────────────────────────────────
  const epochAfter = await viewFunction(contractId, "get_mandate_epoch");
  const pathAfter = await viewFunction(contractId, "get_derivation_path");
  const derivedAfter = await derivedPublicKey(contractId, pathAfter, 0);
  evidence.steps.path_custody = {
    before: { epoch, path, derived },
    after_revoke: { epoch: epochAfter, path: pathAfter, derived: derivedAfter },
    finding:
      "Path trading/v1/<mandate_epoch> CHANGES when revoke/set_policy increments epoch. Because MPC address = derive(predecessor=contract, path), a new epoch yields a DIFFERENT custody identity. Funds at the old derived address are not automatically moved.",
    recommendation: [
      "Use a STABLE path for capital custody, e.g. trading/v1/portfolio/<portfolio_id>, and bind epoch in the payload commitment / nonce — not in the derivation path.",
      "OR keep epoch in path only for short-lived intent keys that never hold balances, and use a separate treasury path for balances.",
      "Never accept caller-supplied paths.",
      "Document address migration explicitly on policy rotate.",
    ],
  };
  save("17-path-custody.json", evidence.steps.path_custody);

  // ── 9. Fabricated settlement by agent ─────────────────────────────────
  let fakeSettleErr = null;
  let fakeSettleOk = false;
  try {
    await agent.functionCall({
      contractId,
      methodName: "mark_settlement",
      args: { operation_id: operationId, settlement_state: "Success" },
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
    fakeSettleOk = true;
  } catch (e) {
    fakeSettleErr = String(e);
  }
  const pendingAfterFake = await viewFunction(contractId, "get_pending", { operation_id: operationId });
  evidence.steps.fabricated_settlement = {
    agent_call_ok: fakeSettleOk,
    error: fakeSettleErr,
    blocked: !fakeSettleOk && /only owner or self|agent/i.test(fakeSettleErr || ""),
    pending_unchanged_terminal:
      pendingAfterFake?.settlement_state !== "Success" &&
      pendingAfterFake?.settlement_state !== "Reconciled",
    pending: pendingAfterFake,
  };
  save("18-fabricated-settlement.json", evidence.steps.fabricated_settlement);
  evidence.gates.settlement_not_agent_advancable = {
    status:
      evidence.steps.fabricated_settlement.blocked &&
      evidence.steps.fabricated_settlement.pending_unchanged_terminal
        ? "PASS"
        : "FAIL",
  };

  evidence.finished_at = new Date().toISOString();
  save("gate-b-evidence.json", evidence);
  console.log("\n=== GATE SUMMARY ===");
  console.log(JSON.stringify(evidence.gates, null, 2));
  return evidence;
}

function summarizeReceipts(result) {
  if (!result?.receipts_outcome) return null;
  return result.receipts_outcome.map((r) => ({
    executor_id: r.outcome.executor_id,
    status: r.outcome.status,
    logs: r.outcome.logs,
    receipt_ids: r.outcome.receipt_ids,
  }));
}

function extractTxHash(err) {
  if (!err) return null;
  const m = String(err).match(/([A-Za-z0-9]{40,50})/);
  return m ? m[1] : null;
}

function extractSignatureFromTx(fullTx) {
  const out = { found: false, candidates: [] };
  const outcomes = fullTx?.result?.receipts_outcome || fullTx?.receipts_outcome || [];
  for (const r of outcomes) {
    const status = r?.outcome?.status;
    if (status?.SuccessValue && status.SuccessValue.length > 0) {
      try {
        const decoded = Buffer.from(status.SuccessValue, "base64").toString("utf8");
        out.candidates.push({
          executor_id: r.outcome.executor_id,
          decoded_prefix: decoded.slice(0, 500),
        });
        if (
          decoded.includes("Secp256k1") ||
          decoded.includes("big_r") ||
          decoded.includes("scheme")
        ) {
          out.found = true;
          out.signature_json = JSON.parse(decoded);
          out.executor_id = r.outcome.executor_id;
        }
      } catch {
        out.candidates.push({
          executor_id: r.outcome.executor_id,
          success_value_b64_len: status.SuccessValue.length,
        });
      }
    }
    for (const log of r?.outcome?.logs || []) {
      if (/signed|Secp256k1|signature/i.test(log)) {
        out.candidates.push({ log, executor_id: r.outcome.executor_id });
      }
    }
  }
  // Also scan transaction status SuccessValue
  const top = fullTx?.result?.status || fullTx?.status;
  if (top?.SuccessValue) {
    try {
      const decoded = Buffer.from(top.SuccessValue, "base64").toString("utf8");
      out.top_level_success_value = decoded.slice(0, 1000);
      if (decoded.includes("Secp256k1") || decoded.includes("big_r")) {
        out.found = true;
        out.signature_json = JSON.parse(decoded);
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function independentlyVerify({ payloadCommitment, signatureExtraction, derived, rootPk }) {
  const result = {
    payload_commitment: payloadCommitment,
    derived_public_key: derived,
    mpc_root_public_key: rootPk,
    verified: false,
    method: null,
    notes: [],
  };
  if (!signatureExtraction?.found || !signatureExtraction.signature_json) {
    result.notes.push("No signature JSON extracted from receipts — cannot verify.");
    return result;
  }
  result.signature = signatureExtraction.signature_json;
  result.method = "receipt_extraction_structural_check";
  // Structural check: Secp256k1 scheme with big_r / s / recovery_id
  const sig = signatureExtraction.signature_json;
  const structural =
    (sig.scheme === "Secp256k1" || sig.Secp256k1 || sig.big_r) &&
    (sig.big_r?.affine_point || sig.Secp256k1?.big_r);
  result.structural_ok = !!structural;
  if (structural) {
    result.verified = "partial";
    result.notes.push(
      "Signature structurally matches MPC Secp256k1 response. Full ECDSA recover/verify against derived address requires k256 recover implementation; marked partial until elliptic recover confirms message hash binding."
    );
  } else {
    result.notes.push("Extracted JSON did not match expected Secp256k1 shape.");
  }
  return result;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
