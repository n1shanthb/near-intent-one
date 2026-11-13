/**
 * J8B-S — recover an already-Signed on-chain MPC result after local extraction failure.
 * READ-ONLY inspection by default. Never proposes, never request_signature, never broadcasts.
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import {
  MAINNET_IDENTITIES,
  MAINNET_EVM_RPCS,
  MAINNET_USDC,
} from "./identities.mjs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  CANARY_STATES,
  CANARY_AMOUNT,
  CANARY_TOKEN,
  CANARY_CHAIN_ID,
  CANARY_ASSET_IN,
  CANARY_ASSET_OUT,
  CANARY_ATTESTOR_PK,
  RECOVERY_KIND,
  SIGNED_TX_RECOVERY_KIND,
  DEFAULT_SIGNED_RECOVERY_TTL_MS,
  canaryStoreDir,
  signedRecoveryApprovalPath,
  loadCanaryApproval,
  loadRecoveryAuthorization,
  loadSignedTxRecoveryAuthorization,
  signApprovalPayload,
  getLifecycleState,
  validateExecutableApproval,
  requireOperatorConfirmation,
  recordOperatorConfirmation,
  advanceLifecycle,
  resolveCanaryJournalSecret,
} from "./canaryOneShot.mjs";
import {
  createViewOnlyPolicyAdapters,
  verifyNearProposeReceipt,
} from "./canaryRecovery.mjs";
import {
  extractMpcSigFromNearTx,
  mpcToRsV,
  recoverFromHash,
} from "../gate-k/settle.mjs";
import {
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
  serializeSignedTx,
} from "../intents-codec/quote-auth.mjs";
import { localTxHash, openTxJournal, TX_STATE } from "../execution/txJournal.mjs";
import { ethJsonRpc } from "./canaryAdapters.mjs";

const EXPECTED_MPC = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
const EXPECTED_ESCROW = "0xcaa3dc3d6d2bb72ade403c614949e66d5ed37f1e";
const EXPECTED_TOKEN = String(CANARY_TOKEN).toLowerCase();
const EXPECTED_GAS_PRICE = "30000000";
const EXPECTED_GAS_LIMIT = "100000";
const EXPECTED_NONCE = 0;

function verifySignedEvent(nearTxFull, operationId) {
  const receipts = [
    ...(nearTxFull?.receipts_outcome || []),
    ...(nearTxFull?.result?.receipts_outcome || []),
  ];
  const txOutcome =
    nearTxFull?.transaction_outcome || nearTxFull?.result?.transaction_outcome;
  const nodes = [...receipts];
  if (txOutcome) nodes.push(txOutcome);
  let found = false;
  let mismatch = null;
  for (const node of nodes) {
    for (const l of node?.outcome?.logs || []) {
      const s = String(l);
      if (!s.startsWith("EVENT_JSON:")) continue;
      try {
        const j = JSON.parse(s.slice("EVENT_JSON:".length));
        if (j?.event !== "signed") continue;
        if (String(j.operation_id) !== String(operationId)) {
          mismatch = j.operation_id;
          continue;
        }
        found = true;
      } catch {
        /* */
      }
    }
  }
  if (mismatch && !found) {
    return { ok: false, reason: "signed_event_operation_id_mismatch", got: mismatch };
  }
  if (!found) return { ok: false, reason: "signed_event_missing" };
  return { ok: true };
}

/**
 * Assemble + verify EIP-155 raw from extracted MPC sig. Never logs raw bytes.
 */
export function assembleAndVerifySignedCanaryTx({
  nearTxFull,
  operationId,
  digestHexExpected,
  depositAddress = EXPECTED_ESCROW,
  nonce = EXPECTED_NONCE,
  gasPrice = EXPECTED_GAS_PRICE,
  gasLimit = EXPECTED_GAS_LIMIT,
  token = EXPECTED_TOKEN,
  chainId = CANARY_CHAIN_ID,
  amount = CANARY_AMOUNT,
  expectedMpc = EXPECTED_MPC,
} = {}) {
  const extracted = extractMpcSigFromNearTx(nearTxFull);
  if (!extracted.found) {
    return {
      ok: false,
      reason: extracted.reason || "MPC_SIG_NOT_FOUND",
      candidate_count: extracted.candidate_count,
      unique_count: extracted.unique_count,
      malformed_count: extracted.malformed_count,
    };
  }

  const data = erc20TransferData(depositAddress, amount);
  const digestBytes = eip155UnsignedDigest({
    nonce: BigInt(nonce),
    gasPrice: BigInt(gasPrice),
    gasLimit: BigInt(gasLimit),
    to: token,
    data,
    chainId: Number(chainId),
  });
  const digest_hex = digestHex(digestBytes);
  if (
    digestHexExpected &&
    digest_hex.toLowerCase() !== String(digestHexExpected).toLowerCase()
  ) {
    return { ok: false, reason: "digest_recalc_mismatch", digest_hex };
  }

  let { r, s, recoveryId } = mpcToRsV(extracted.signature_json);
  let recovered = recoverFromHash(digestBytes, r, s, recoveryId);
  const mpc = String(expectedMpc).toLowerCase();
  if (recovered.toLowerCase() !== mpc) {
    const alt = recoveryId ^ 1;
    if (recoverFromHash(digestBytes, r, s, alt).toLowerCase() === mpc) {
      recoveryId = alt;
      recovered = mpc;
    }
  }
  if (recovered.toLowerCase() !== mpc) {
    return {
      ok: false,
      reason: "recovered_address_mismatch",
      recovered: recovered.toLowerCase(),
      expected: mpc,
    };
  }

  const rawHex = serializeSignedTx({
    nonce: BigInt(nonce),
    gasPrice: BigInt(gasPrice),
    gasLimit: BigInt(gasLimit),
    to: token,
    data,
    chainId: Number(chainId),
    r,
    s,
    recoveryId,
  });
  const local_tx_hash = localTxHash(rawHex);

  return {
    ok: true,
    digest_hex,
    recovered: mpc,
    local_tx_hash,
    rawHex, // caller must not print; persist only under explicit confirm
    candidate_count: extracted.candidate_count,
    unique_count: extracted.unique_count,
    tx_fields: {
      chain_id: Number(chainId),
      nonce: Number(nonce),
      token: String(token).toLowerCase(),
      escrow: String(depositAddress).toLowerCase(),
      amount: String(amount),
      gas_price: String(gasPrice),
      gas_limit: String(gasLimit),
      operation_id: operationId || null,
    },
  };
}

async function checkArbNonceStatus({
  mpc = EXPECTED_MPC,
  expectedNonce = EXPECTED_NONCE,
  rpcUrl = MAINNET_EVM_RPCS.arbitrum,
  eth = null,
} = {}) {
  const call = eth || ((method, params) => ethJsonRpc(rpcUrl, method, params));
  try {
    const latestJ = await call("eth_getTransactionCount", [mpc, "latest"]);
    const pendingJ = await call("eth_getTransactionCount", [mpc, "pending"]);
    const latest =
      latestJ?.result != null
        ? Number.parseInt(String(latestJ.result), 16)
        : null;
    const pending =
      pendingJ?.result != null
        ? Number.parseInt(String(pendingJ.result), 16)
        : null;
    if (latest == null || Number.isNaN(latest)) {
      return {
        ok: false,
        reason: "arb_nonce_unreadable",
        mpc_nonce: null,
        expected_nonce: expectedNonce,
      };
    }
    const pendingCount =
      pending != null && !Number.isNaN(pending) ? pending : latest;
    const pendingTxInFlight = pendingCount > latest;
    return {
      ok: true,
      mpc_nonce: latest,
      mpc_nonce_pending: pendingCount,
      expected_nonce: Number(expectedNonce),
      pending_tx_in_flight: pendingTxInFlight,
      nonce_available_for_broadcast:
        latest === Number(expectedNonce) && !pendingTxInFlight,
      possible_prior_broadcast: latest > Number(expectedNonce),
    };
  } catch (e) {
    return {
      ok: false,
      reason: "arb_nonce_rpc_failed",
      error: String(e.message || e),
    };
  }
}

/**
 * READ-ONLY inspection of an already-Signed PendingOp + signing parent tx.
 * Does not print raw signature bytes or raw tx hex.
 */
export async function inspectSignedRecovery({
  operationId,
  nearSignTx,
  nearProposeTx = null,
  env = process.env,
  storeDir = null,
  adapters = null,
  testHarness = false,
  deps = {},
} = {}) {
  if (!operationId) return { ok: false, reason: "operation_id_required" };
  if (!nearSignTx) return { ok: false, reason: "near_sign_tx_required" };

  const a =
    adapters ||
    deps.adapters ||
    (testHarness ? null : await createViewOnlyPolicyAdapters({ env }));
  if (!a?.getPending || !a?.getPaused) {
    return { ok: false, reason: "view_adapters_missing" };
  }

  const paused = await a.getPaused();
  const epoch = await a.getMandateEpoch();
  const pending =
    deps.pending || (await a.getPending(operationId));

  const original = loadCanaryApproval(operationId, { env, storeDir });
  const priorRecovery = loadRecoveryAuthorization(operationId, {
    env,
    storeDir,
  });
  const existingSigned = loadSignedTxRecoveryAuthorization(operationId, {
    env,
    storeDir,
  });

  const wantDigest = original.ok
    ? String(original.record.locked_digest_hex || "").toLowerCase()
    : deps.expectedDigest
      ? String(deps.expectedDigest).toLowerCase()
      : null;

  let nearTx = deps.nearTx || null;
  if (!nearTx && a.waitNearTx) {
    try {
      nearTx = await a.waitNearTx(nearSignTx);
    } catch (e) {
      nearTx = null;
      deps._near_tx_error = String(e.message || e);
    }
  }

  const tx = nearTx?.transaction || nearTx?.result?.transaction || null;
  const signer = tx?.signer_id || null;
  const receiver = tx?.receiver_id || null;

  const status =
    nearTx?.status ||
    nearTx?.transaction_outcome?.outcome?.status ||
    nearTx?.result?.status;
  const txSuccess =
    status?.SuccessValue != null ||
    status?.SuccessReceiptId != null ||
    (typeof status === "string" && /success/i.test(status));

  const signedEvent = nearTx
    ? verifySignedEvent(nearTx, operationId)
    : { ok: false, reason: "near_tx_missing" };

  const nonce = original.ok
    ? Number(original.record.locked_nonce)
    : EXPECTED_NONCE;
  const gasPrice = original.ok
    ? String(original.record.locked_gas_price || EXPECTED_GAS_PRICE)
    : EXPECTED_GAS_PRICE;
  const gasLimit = original.ok
    ? String(original.record.locked_gas_limit || EXPECTED_GAS_LIMIT)
    : EXPECTED_GAS_LIMIT;
  const deposit = original.ok
    ? String(original.record.payload?.deposit_address || EXPECTED_ESCROW).toLowerCase()
    : EXPECTED_ESCROW;

  const assembled = deps.assembled
    ? deps.assembled
    : nearTx
      ? assembleAndVerifySignedCanaryTx({
          nearTxFull: nearTx,
          operationId,
          digestHexExpected: wantDigest,
          depositAddress: deposit,
          nonce,
          gasPrice,
          gasLimit,
        })
      : { ok: false, reason: "near_tx_missing" };

  // Strip raw material from inspect surface.
  const assembledPublic = assembled.ok
    ? {
        ok: true,
        digest_hex: assembled.digest_hex,
        recovered: assembled.recovered,
        local_tx_hash: assembled.local_tx_hash,
        candidate_count: assembled.candidate_count,
        unique_count: assembled.unique_count,
        tx_fields: assembled.tx_fields,
      }
    : {
        ok: false,
        reason: assembled.reason,
        candidate_count: assembled.candidate_count ?? null,
        unique_count: assembled.unique_count ?? null,
        malformed_count: assembled.malformed_count ?? null,
        recovered: assembled.recovered || null,
      };

  const arb =
    deps.arbNonce ||
    (await checkArbNonceStatus({
      expectedNonce: nonce,
      eth: deps.eth || null,
    }));

  let proposeReceipt = deps.proposeReceiptVerify || null;
  if (nearProposeTx && !proposeReceipt) {
    if (a?.waitNearTx) {
      try {
        const proposeTxFull = await a.waitNearTx(nearProposeTx);
        proposeReceipt = verifyNearProposeReceipt(proposeTxFull, {
          operationId,
          expectedDigest: wantDigest,
        });
      } catch (e) {
        proposeReceipt = {
          ok: false,
          reason: "propose_tx_fetch_failed",
          error: String(e.message || e),
        };
      }
    } else {
      proposeReceipt = { ok: false, reason: "propose_tx_adapter_missing" };
    }
  }

  const epochMandateOk = Number(epoch) === 2;
  const epochPendingOk = Number(pending?.epoch) === 2;
  const proposeReceiptOk = !nearProposeTx || proposeReceipt?.ok === true;

  const checks = {
    pending_exists: Boolean(pending),
    signing_signed: String(pending?.signing_state) === "Signed",
    settlement_none:
      String(pending?.settlement_state || "") === "None" ||
      pending?.settlement_state === "",
    epoch_mandate_match: epochMandateOk,
    epoch_pending_match: epochPendingOk,
    epoch_match: epochMandateOk && epochPendingOk,
    propose_receipt_ok: proposeReceiptOk,
    digest_match: wantDigest
      ? String(pending?.payload_commitment || "").toLowerCase() === wantDigest
      : false,
    policy_paused: paused === true,
    near_sign_tx_present: Boolean(nearTx),
    near_tx_success: Boolean(txSuccess),
    signer_agent: signer === MAINNET_IDENTITIES.agent,
    receiver_policy: receiver === MAINNET_IDENTITIES.policy,
    signed_event_ok: signedEvent.ok === true,
    mpc_sig_extracted: assembled.ok === true,
    recovered_mpc_match:
      assembled.ok &&
      String(assembled.recovered).toLowerCase() === EXPECTED_MPC,
    digest_recalc_ok:
      assembled.ok &&
      wantDigest &&
      String(assembled.digest_hex).toLowerCase() === wantDigest,
    tx_field_chain_id:
      assembled.ok && assembled.tx_fields.chain_id === CANARY_CHAIN_ID,
    tx_field_nonce: assembled.ok && assembled.tx_fields.nonce === Number(nonce),
    tx_field_token:
      assembled.ok && assembled.tx_fields.token === EXPECTED_TOKEN,
    tx_field_escrow:
      assembled.ok && assembled.tx_fields.escrow === deposit,
    tx_field_amount:
      assembled.ok && assembled.tx_fields.amount === CANARY_AMOUNT,
    tx_field_gas_price:
      assembled.ok && assembled.tx_fields.gas_price === String(gasPrice),
    tx_field_gas_limit:
      assembled.ok && assembled.tx_fields.gas_limit === String(gasLimit),
    original_immutable_failed:
      original.ok &&
      original.record.used === true &&
      getLifecycleState(original.record) === CANARY_STATES.FAILED,
    prior_recovery_immutable_failed:
      !priorRecovery.ok ||
      getLifecycleState(priorRecovery.record) === CANARY_STATES.FAILED,
    no_local_broadcast:
      (!original.ok || original.record.locked_broadcast_hash == null) &&
      (!priorRecovery.ok || priorRecovery.record.locked_broadcast_hash == null),
    arb_nonce_ok: arb.ok === true && arb.nonce_available_for_broadcast === true,
    signed_recovery_auth_absent: !existingSigned.ok,
  };

  const safe =
    checks.pending_exists &&
    checks.signing_signed &&
    checks.settlement_none &&
    checks.epoch_match &&
    checks.propose_receipt_ok &&
    checks.digest_match &&
    checks.policy_paused &&
    checks.near_sign_tx_present &&
    checks.near_tx_success &&
    checks.signer_agent &&
    checks.receiver_policy &&
    checks.signed_event_ok &&
    checks.mpc_sig_extracted &&
    checks.recovered_mpc_match &&
    checks.digest_recalc_ok &&
    checks.tx_field_chain_id &&
    checks.tx_field_nonce &&
    checks.tx_field_token &&
    checks.tx_field_escrow &&
    checks.tx_field_amount &&
    checks.tx_field_gas_price &&
    checks.tx_field_gas_limit &&
    checks.original_immutable_failed &&
    checks.no_local_broadcast &&
    checks.arb_nonce_ok &&
    checks.signed_recovery_auth_absent;

  return {
    ok: true,
    read_only: true,
    mutations_invoked: false,
    operation_id: operationId,
    near_sign_tx: nearSignTx,
    near_propose_tx: nearProposeTx || null,
    policy_paused_onchain: paused === true,
    mandate_epoch: epoch,
    pending: pending
      ? {
          epoch: pending.epoch,
          signing_state: pending.signing_state,
          settlement_state: pending.settlement_state,
          payload_commitment: pending.payload_commitment,
          amount_in: pending.amount_in,
          destination: pending.destination,
        }
      : null,
    near_tx_meta: {
      signer_id: signer,
      receiver_id: receiver,
      success: Boolean(txSuccess),
      receipt_outcomes:
        (nearTx?.receipts_outcome || nearTx?.result?.receipts_outcome || [])
          .length,
    },
    signed_event: signedEvent,
    assembled: assembledPublic,
    arb_nonce: arb,
    propose_receipt: proposeReceipt,
    local_original: original.ok
      ? {
          used: original.record.used,
          lifecycle_state: getLifecycleState(original.record),
          consume_reason: original.record.consume_reason || null,
          locked_digest_hex: original.record.locked_digest_hex,
          fingerprint: original.record.fingerprint,
          locked_local_tx_hash: original.record.locked_local_tx_hash,
          locked_broadcast_hash: original.record.locked_broadcast_hash,
          path: original.path,
        }
      : null,
    prior_recovery: priorRecovery.ok
      ? {
          used: priorRecovery.record.used,
          lifecycle_state: getLifecycleState(priorRecovery.record),
          expires_at: priorRecovery.record.payload?.expires_at || null,
          fingerprint: priorRecovery.record.fingerprint,
          path: priorRecovery.path,
        }
      : null,
    signed_recovery_auth_exists: existingSigned.ok,
    checks,
    safe_to_create_signed_recovery_auth: Boolean(safe),
    verdict: safe
      ? "SAFE_TO_CREATE_SIGNED_TX_RECOVERY_AUTH"
      : "NO-GO",
    note: "Read-only. No raw signature/tx bytes returned. Do not request_signature again. Do not extend prior recovery TTL.",
  };
}

/**
 * Create a short-lived signed-tx recovery authorization for an already-Signed op.
 * Preserves original FAILED and prior recovery FAILED files unchanged.
 * Does NOT persist raw tx / journal / broadcast.
 */
export async function createSignedTxRecoveryAuthorization({
  operationId,
  nearSignTx,
  nearProposeTx = null,
  env = process.env,
  storeDir = null,
  adapters = null,
  testHarness = false,
  operatorConfirmed = false,
  ttlMs = DEFAULT_SIGNED_RECOVERY_TTL_MS,
  deps = {},
} = {}) {
  if (!operatorConfirmed) {
    return {
      ok: false,
      reason: "operator_confirm_required:create_signed_recovery",
      verdict: "NO-GO",
    };
  }

  const inspect = await inspectSignedRecovery({
    operationId,
    nearSignTx,
    nearProposeTx,
    env,
    storeDir,
    adapters,
    testHarness,
    deps,
  });
  if (!inspect.safe_to_create_signed_recovery_auth) {
    return {
      ok: false,
      reason: "unsafe_to_create_signed_recovery_auth",
      inspect,
      verdict: "NO-GO",
    };
  }

  const original = loadCanaryApproval(operationId, { env, storeDir });
  if (!original.ok || original.record.used !== true) {
    return { ok: false, reason: "original_must_be_consumed_failed" };
  }
  const prior = loadRecoveryAuthorization(operationId, { env, storeDir });
  const existing = loadSignedTxRecoveryAuthorization(operationId, {
    env,
    storeDir,
  });
  if (existing.ok) {
    return {
      ok: false,
      reason: "signed_recovery_auth_already_exists",
      path: existing.path,
    };
  }

  // Re-assemble under confirm (still do not persist raw to disk here).
  const a =
    adapters ||
    deps.adapters ||
    (testHarness ? null : await createViewOnlyPolicyAdapters({ env }));
  const nearTx =
    deps.nearTx ||
    (a?.waitNearTx ? await a.waitNearTx(nearSignTx) : null);
  if (!nearTx && !deps.assembled) {
    return { ok: false, reason: "near_sign_tx_fetch_failed" };
  }

  const assembled =
    deps.assembled ||
    assembleAndVerifySignedCanaryTx({
      nearTxFull: nearTx,
      operationId,
      digestHexExpected: original.record.locked_digest_hex,
      depositAddress: original.record.payload.deposit_address,
      nonce: original.record.locked_nonce,
      gasPrice: original.record.locked_gas_price,
      gasLimit: original.record.locked_gas_limit,
    });
  if (!assembled.ok) {
    return { ok: false, reason: assembled.reason, verdict: "NO-GO" };
  }
  if (!assembled.local_tx_hash || !assembled.digest_hex || !assembled.recovered) {
    return { ok: false, reason: "assembled_bindings_incomplete", verdict: "NO-GO" };
  }

  const priorQv = prior.ok
    ? prior.record.outcomes?.[CANARY_STATES.QUOTE_VERIFIED] || {}
    : {};
  const origQv =
    original.record.outcomes?.[CANARY_STATES.QUOTE_VERIFIED] || {};
  const quote_deadline_ms =
    priorQv.quote_deadline_ms ?? origQv.quote_deadline_ms ?? null;
  const min_amount_out = String(
    priorQv.min_out || origQv.min_out || "994904"
  );
  if (quote_deadline_ms == null) {
    return { ok: false, reason: "original_quote_deadline_missing" };
  }

  const dir = storeDir || canaryStoreDir(env);
  mkdirSync(dir, { recursive: true });
  const path = signedRecoveryApprovalPath(operationId, dir);
  if (existsSync(path)) {
    return { ok: false, reason: "signed_recovery_auth_already_exists", path };
  }

  const expires_at = new Date(Date.now() + ttlMs).toISOString();
  const payload = {
    operation_id: operationId,
    owner: MAINNET_IDENTITIES.owner,
    policy: MAINNET_IDENTITIES.policy,
    agent: MAINNET_IDENTITIES.agent,
    mandate_epoch: 2,
    chain_id: CANARY_CHAIN_ID,
    token: CANARY_TOKEN,
    asset_in: CANARY_ASSET_IN,
    asset_out: CANARY_ASSET_OUT,
    amount: CANARY_AMOUNT,
    mpc: EXPECTED_MPC,
    attestor_public_key: CANARY_ATTESTOR_PK,
    max_gas_price: String(original.record.payload.max_gas_price),
    max_slippage_bps: Number(original.record.payload.max_slippage_bps),
    quote_hash: original.record.payload.quote_hash,
    deposit_address: String(original.record.payload.deposit_address).toLowerCase(),
    expires_at,
    kind: SIGNED_TX_RECOVERY_KIND,
    recovery_of_fingerprint: original.record.fingerprint,
    prior_recovery_fingerprint: prior.ok ? prior.record.fingerprint : null,
    near_propose_tx: nearProposeTx || null,
    near_sign_tx: nearSignTx,
    forbids_propose: true,
    forbids_request_signature: true,
    digest_hex: String(assembled.digest_hex).toLowerCase(),
    local_tx_hash: String(assembled.local_tx_hash).toLowerCase(),
    recovered_signer: assembled.recovered,
    quote_deadline_ms: Number(quote_deadline_ms),
    min_amount_out,
    recipient: EXPECTED_MPC,
    refund_to: EXPECTED_MPC,
    base_usdc_before:
      original.record.base_usdc_before != null
        ? String(original.record.base_usdc_before)
        : "0",
    locked_nonce: Number(original.record.locked_nonce),
    locked_gas_price: String(original.record.locked_gas_price),
    locked_gas_limit: String(original.record.locked_gas_limit),
  };
  const { mac, fingerprint } = signApprovalPayload(payload, env);
  const record = {
    version: 2,
    created_at: new Date().toISOString(),
    payload,
    mac,
    fingerprint,
    used: false,
    used_at: null,
    lifecycle_state: CANARY_STATES.MPC_SIGNED,
    locked_nonce: original.record.locked_nonce,
    locked_digest_hex: String(assembled.digest_hex).toLowerCase(),
    locked_local_tx_hash: String(assembled.local_tx_hash).toLowerCase(),
    locked_broadcast_hash: null,
    locked_gas_price: original.record.locked_gas_price,
    locked_gas_limit: original.record.locked_gas_limit,
    base_usdc_before: original.record.base_usdc_before,
    outcomes: {
      [CANARY_STATES.QUOTE_VERIFIED]: {
        at: new Date().toISOString(),
        quote_hash: original.record.payload.quote_hash,
        deposit: original.record.payload.deposit_address,
        min_out: min_amount_out,
        quote_deadline_ms: Number(quote_deadline_ms),
        recovered_from_signed: true,
      },
      [CANARY_STATES.MPC_SIGNED]: {
        at: new Date().toISOString(),
        near_sign_tx: nearSignTx,
        recovered: assembled.recovered,
        local_tx_hash: assembled.local_tx_hash,
        digest_hex: assembled.digest_hex,
        candidate_count: assembled.candidate_count,
        unique_count: assembled.unique_count,
        note: "raw_tx_not_persisted_until_explicit_operator_step",
      },
    },
    consumed_phases: {},
    operator_confirmations: {},
    original_approval_path: original.path,
    prior_recovery_path: prior.ok ? prior.path : null,
  };
  writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });

  // Integrity: prior FAILED records unchanged
  const origRecheck = loadCanaryApproval(operationId, { env, storeDir });
  if (
    !origRecheck.ok ||
    origRecheck.record.mac !== original.record.mac ||
    getLifecycleState(origRecheck.record) !== CANARY_STATES.FAILED
  ) {
    return { ok: false, reason: "original_integrity_violation" };
  }
  if (prior.ok) {
    const priorRecheck = loadRecoveryAuthorization(operationId, {
      env,
      storeDir,
    });
    if (
      !priorRecheck.ok ||
      priorRecheck.record.mac !== prior.record.mac ||
      getLifecycleState(priorRecheck.record) !== CANARY_STATES.FAILED
    ) {
      return { ok: false, reason: "prior_recovery_integrity_violation" };
    }
  }

  return {
    ok: true,
    path,
    fingerprint,
    operation_id: operationId,
    lifecycle_state: CANARY_STATES.MPC_SIGNED,
    locked_digest_hex: record.locked_digest_hex,
    local_tx_hash: record.locked_local_tx_hash,
    recovered_signer: assembled.recovered,
    forbids_propose: true,
    forbids_request_signature: true,
    raw_persisted: false,
    original_immutable: true,
    prior_recovery_immutable: true,
    expires_at,
    verdict: "SIGNED_TX_RECOVERY_AUTH_CREATED",
    next: "Separately confirm persist-signed-raw (journal) then READY_TO_BROADCAST; never request_signature; keep policy paused until approved broadcast window",
    inspect,
  };
}

/**
 * Persist recovered signed EVM bytes into the durable journal and advance
 * signed-recovery auth MPC_SIGNED → READY_TO_BROADCAST.
 * Default is dry-run. Never proposes, request_signature, or broadcasts.
 */
export async function persistSignedRawCanary({
  operationId,
  nearSignTx = null,
  nearProposeTx = null,
  env = process.env,
  storeDir = null,
  adapters = null,
  testHarness = false,
  invoke = false,
  operatorConfirmed = false,
  deps = {},
} = {}) {
  const signed = loadSignedTxRecoveryAuthorization(operationId, {
    env,
    storeDir,
  });
  if (!signed.ok) return { ok: false, reason: signed.reason };

  if (operatorConfirmed) {
    recordOperatorConfirmation(operationId, "persist_signed_raw", {
      env,
      storeDir,
      confirmed: true,
      note: "inline_confirm_persist",
    });
  }

  const v = validateExecutableApproval(operationId, {
    env,
    storeDir,
    requireQuoteBound: true,
    allowRecovery: true,
    allowSignedRecovery: true,
  });
  if (!v.ok) return { ok: false, reason: v.reason };
  if (!v.is_signed_recovery || v.payload?.kind !== SIGNED_TX_RECOVERY_KIND) {
    return { ok: false, reason: "signed_recovery_auth_required" };
  }
  if (getLifecycleState(v.record) !== CANARY_STATES.MPC_SIGNED) {
    // Idempotent: already READY_TO_BROADCAST with matching journal is OK below
    if (getLifecycleState(v.record) !== CANARY_STATES.READY_TO_BROADCAST) {
      return {
        ok: false,
        reason: `bad_state:${getLifecycleState(v.record)}`,
      };
    }
  }

  const need = requireOperatorConfirmation(v.record, "persist_signed_raw");
  // Re-load after possible inline confirm
  const signedAfter = loadSignedTxRecoveryAuthorization(operationId, {
    env,
    storeDir,
  });
  const need2 = requireOperatorConfirmation(
    signedAfter.ok ? signedAfter.record : v.record,
    "persist_signed_raw"
  );
  if (!need.ok && !need2.ok && invoke) {
    return { ok: false, reason: need2.reason || need.reason };
  }

  const original = loadCanaryApproval(operationId, { env, storeDir });
  if (!original.ok || original.record.used !== true) {
    return { ok: false, reason: "original_must_remain_consumed_failed" };
  }
  if (
    String(v.payload.recovery_of_fingerprint) !==
    String(original.record.fingerprint)
  ) {
    return { ok: false, reason: "recovery_fingerprint_mismatch" };
  }
  const prior = loadRecoveryAuthorization(operationId, { env, storeDir });
  if (prior.ok) {
    if (getLifecycleState(prior.record) !== CANARY_STATES.FAILED) {
      return { ok: false, reason: "prior_recovery_not_failed" };
    }
    if (
      v.payload.prior_recovery_fingerprint &&
      String(v.payload.prior_recovery_fingerprint) !==
        String(prior.record.fingerprint)
    ) {
      return { ok: false, reason: "prior_recovery_fingerprint_mismatch" };
    }
  }

  const signTx = nearSignTx || v.payload.near_sign_tx;
  if (!signTx) return { ok: false, reason: "near_sign_tx_required" };
  if (
    v.payload.near_sign_tx &&
    String(signTx) !== String(v.payload.near_sign_tx)
  ) {
    return { ok: false, reason: "near_sign_tx_mismatch" };
  }

  const a =
    adapters ||
    deps.adapters ||
    (testHarness ? null : await createViewOnlyPolicyAdapters({ env }));
  if (!a?.getPending || !a?.getPaused) {
    return { ok: false, reason: "view_adapters_missing" };
  }

  const paused = await a.getPaused();
  if (paused !== true) {
    return { ok: false, reason: "policy_must_remain_paused_for_persist" };
  }
  const epoch = await a.getMandateEpoch();
  const pending = deps.pending || (await a.getPending(operationId));
  if (!pending) return { ok: false, reason: "pending_missing" };
  if (String(pending.signing_state) !== "Signed") {
    return { ok: false, reason: "signing_state_not_signed" };
  }
  if (
    String(pending.settlement_state || "") !== "None" &&
    pending.settlement_state !== ""
  ) {
    return { ok: false, reason: "settlement_state_not_none" };
  }
  if (Number(epoch) !== 2 || Number(pending.epoch) !== 2) {
    return {
      ok: false,
      reason: "epoch_mismatch",
      mandate_epoch: epoch,
      pending_epoch: pending.epoch,
    };
  }
  if (
    String(pending.payload_commitment || "").toLowerCase() !==
    String(v.record.locked_digest_hex).toLowerCase()
  ) {
    return { ok: false, reason: "payload_commitment_mismatch" };
  }
  if (
    String(pending.destination || "").toLowerCase() !==
    String(v.payload.deposit_address).toLowerCase()
  ) {
    return { ok: false, reason: "pending_deposit_mismatch" };
  }
  const amountIn =
    pending.amount_in?.[""] != null
      ? String(pending.amount_in[""])
      : String(pending.amount_in || "");
  if (amountIn && amountIn !== CANARY_AMOUNT) {
    return { ok: false, reason: "pending_amount_mismatch", got: amountIn };
  }

  const arb =
    deps.arbNonce ||
    (await checkArbNonceStatus({
      expectedNonce: Number(v.record.locked_nonce),
      eth: deps.eth || null,
    }));
  if (!arb.ok || arb.nonce_available_for_broadcast !== true) {
    return {
      ok: false,
      reason: arb.reason || "arb_nonce_not_available",
      arb_nonce: arb,
    };
  }

  if (nearProposeTx || v.payload.near_propose_tx) {
    const proposeHash = nearProposeTx || v.payload.near_propose_tx;
    let proposeReceipt = deps.proposeReceiptVerify || null;
    if (!proposeReceipt && a.waitNearTx) {
      try {
        const full = await a.waitNearTx(proposeHash);
        proposeReceipt = verifyNearProposeReceipt(full, {
          operationId,
          expectedDigest: v.record.locked_digest_hex,
        });
      } catch (e) {
        proposeReceipt = {
          ok: false,
          reason: "propose_tx_fetch_failed",
          error: String(e.message || e),
        };
      }
    }
    if (!proposeReceipt?.ok) {
      return {
        ok: false,
        reason: "propose_receipt_required",
        propose_receipt: proposeReceipt,
      };
    }
  }

  let nearTx = deps.nearTx || null;
  if (!nearTx && a.waitNearTx) {
    try {
      nearTx = await a.waitNearTx(signTx);
    } catch (e) {
      return {
        ok: false,
        reason: "near_sign_tx_fetch_failed",
        error: String(e.message || e),
      };
    }
  }
  if (!nearTx && !deps.assembled) {
    return { ok: false, reason: "near_sign_tx_missing" };
  }

  const assembled =
    deps.assembled ||
    assembleAndVerifySignedCanaryTx({
      nearTxFull: nearTx,
      operationId,
      digestHexExpected: v.record.locked_digest_hex,
      depositAddress: v.payload.deposit_address,
      nonce: v.record.locked_nonce,
      gasPrice: v.record.locked_gas_price,
      gasLimit: v.record.locked_gas_limit,
    });
  if (!assembled.ok) {
    return { ok: false, reason: assembled.reason, verdict: "NO-GO" };
  }
  if (!assembled.rawHex) {
    return { ok: false, reason: "assembled_raw_missing", verdict: "NO-GO" };
  }

  const wantHash = String(
    v.record.locked_local_tx_hash || v.payload.local_tx_hash || ""
  ).toLowerCase();
  const gotHash = String(assembled.local_tx_hash).toLowerCase();
  if (!wantHash || gotHash !== wantHash) {
    return {
      ok: false,
      reason: "local_tx_hash_mismatch",
      expected: wantHash,
      got: gotHash,
      verdict: "NO-GO",
    };
  }
  if (localTxHash(assembled.rawHex).toLowerCase() !== gotHash) {
    return { ok: false, reason: "raw_bytes_hash_mismatch", verdict: "NO-GO" };
  }
  if (String(assembled.recovered).toLowerCase() !== EXPECTED_MPC) {
    return { ok: false, reason: "recovered_address_mismatch", verdict: "NO-GO" };
  }
  if (
    String(assembled.digest_hex).toLowerCase() !==
    String(v.record.locked_digest_hex).toLowerCase()
  ) {
    return { ok: false, reason: "digest_mismatch", verdict: "NO-GO" };
  }

  if (!invoke) {
    return {
      ok: true,
      dry: true,
      stage: getLifecycleState(signedAfter.ok ? signedAfter.record : v.record),
      local_tx_hash: gotHash,
      recovered: assembled.recovered,
      digest_hex: assembled.digest_hex,
      candidate_count: assembled.candidate_count,
      unique_count: assembled.unique_count,
      arb_nonce: arb,
      policy_paused: true,
      raw_hex_present: true,
      raw_persisted: false,
      mutations_invoked: false,
      note: "Dry-run only. Pass --confirm-persist and --invoke to journal identical bytes and advance to READY_TO_BROADCAST. Never logs raw bytes.",
    };
  }

  if (!need2.ok) {
    return { ok: false, reason: need2.reason };
  }

  // Journal persistence — crash-safe / idempotent; never overwrite different bytes.
  let journal = deps.journal || null;
  let journalPath = deps.journalPath || null;
  if (!journal) {
    const sec = resolveCanaryJournalSecret({ env, storeDir });
    if (!sec.ok) return sec;
    journalPath =
      journalPath ||
      join(
        storeDir || canaryStoreDir(env) || join(homedir(), ".nio-secure", "mainnet-canary"),
        "tx-journal.sqlite"
      );
    journal = openTxJournal({ path: journalPath, secret: sec.secret });
  }

  const existing = journal.get(operationId);
  if (existing?.local_tx_hash || existing?.signed_raw_enc) {
    const existingHash = String(existing.local_tx_hash || "").toLowerCase();
    if (existingHash && existingHash !== gotHash) {
      return {
        ok: false,
        reason: "journal_conflicting_signed_bytes",
        existing_local_tx_hash: existingHash,
        expected_local_tx_hash: gotHash,
        verdict: "NO-GO",
      };
    }
    const loadedRaw = journal.loadSignedRaw(operationId);
    if (loadedRaw) {
      const loadedHash = localTxHash(loadedRaw).toLowerCase();
      if (loadedHash !== gotHash) {
        return {
          ok: false,
          reason: "journal_conflicting_signed_bytes",
          existing_local_tx_hash: loadedHash,
          expected_local_tx_hash: gotHash,
          verdict: "NO-GO",
        };
      }
      // Idempotent success path
      if (
        getLifecycleState(signedAfter.record) === CANARY_STATES.MPC_SIGNED
      ) {
        advanceLifecycle(operationId, CANARY_STATES.READY_TO_BROADCAST, {
          env,
          storeDir,
          outcome: {
            ready: true,
            local_tx_hash: gotHash,
            journal_idempotent: true,
          },
        });
      }
      return {
        ok: true,
        idempotent: true,
        stage: CANARY_STATES.READY_TO_BROADCAST,
        local_tx_hash: gotHash,
        recovered: assembled.recovered,
        digest_hex: assembled.digest_hex,
        raw_persisted: true,
        mutations_invoked: false,
        journal_state: existing.state,
        note: "Journal already held identical signed bytes — lifecycle ensured READY_TO_BROADCAST. Broadcast remains a separate confirmed step.",
        _journal_path: journalPath,
      };
    }
  }

  if (!existing) {
    journal.insertDraft({
      id: operationId,
      portfolio_id: MAINNET_IDENTITIES.portfolio_id,
      idempotency_key: `canary:${operationId}`,
      nonce: String(v.record.locked_nonce),
      chain_id: String(CANARY_CHAIN_ID),
      quote_deadline_ms: Number(v.payload.quote_deadline_ms) || null,
      meta: {
        digest_hex: assembled.digest_hex,
        deposit: v.payload.deposit_address,
        quote_hash: v.payload.quote_hash,
        near_sign_tx: signTx,
        signed_recovery: true,
      },
    });
  } else if (
    existing.state !== TX_STATE.DRAFT &&
    existing.state !== TX_STATE.SIGNED
  ) {
    return {
      ok: false,
      reason: `journal_bad_state:${existing.state}`,
      verdict: "NO-GO",
    };
  }

  try {
    journal.markSigned(operationId, {
      signedRawHex: assembled.rawHex,
      meta: {
        local_tx_hash: gotHash,
        recovered: assembled.recovered,
        digest_hex: assembled.digest_hex,
        near_sign_tx: signTx,
      },
    });
  } catch (e) {
    return {
      ok: false,
      reason: "journal_mark_signed_failed",
      error: String(e.message || e),
      verdict: "NO-GO",
    };
  }

  // Verify round-trip without logging raw
  const stored = journal.loadSignedRaw(operationId);
  if (!stored || localTxHash(stored).toLowerCase() !== gotHash) {
    return {
      ok: false,
      reason: "journal_persist_verify_failed",
      verdict: "NO-GO",
    };
  }

  const life = getLifecycleState(
    loadSignedTxRecoveryAuthorization(operationId, { env, storeDir }).record
  );
  if (life === CANARY_STATES.MPC_SIGNED) {
    advanceLifecycle(operationId, CANARY_STATES.READY_TO_BROADCAST, {
      env,
      storeDir,
      outcome: {
        ready: true,
        local_tx_hash: gotHash,
        journal_persisted: true,
      },
    });
  } else if (life !== CANARY_STATES.READY_TO_BROADCAST) {
    return { ok: false, reason: `bad_state_after_persist:${life}` };
  }

  // Integrity: FAILED originals unchanged
  const origRecheck = loadCanaryApproval(operationId, { env, storeDir });
  if (
    !origRecheck.ok ||
    origRecheck.record.mac !== original.record.mac ||
    getLifecycleState(origRecheck.record) !== CANARY_STATES.FAILED
  ) {
    return { ok: false, reason: "original_integrity_violation" };
  }
  if (prior.ok) {
    const priorRecheck = loadRecoveryAuthorization(operationId, {
      env,
      storeDir,
    });
    if (
      !priorRecheck.ok ||
      priorRecheck.record.mac !== prior.record.mac ||
      getLifecycleState(priorRecheck.record) !== CANARY_STATES.FAILED
    ) {
      return { ok: false, reason: "prior_recovery_integrity_violation" };
    }
  }

  return {
    ok: true,
    idempotent: false,
    stage: CANARY_STATES.READY_TO_BROADCAST,
    local_tx_hash: gotHash,
    recovered: assembled.recovered,
    digest_hex: assembled.digest_hex,
    raw_persisted: true,
    raw_hex_present: true,
    mutations_invoked: true,
    journal_state: TX_STATE.SIGNED,
    note: "Signed bytes journaled. Broadcast requires separate confirm --phase broadcast and broadcast --invoke under unpause window.",
    next: "confirm --phase broadcast → broadcast --invoke (separate approval)",
    _journal_path: journalPath,
  };
}

void MAINNET_USDC;
void readFileSync;
void RECOVERY_KIND;
void existsSync;
