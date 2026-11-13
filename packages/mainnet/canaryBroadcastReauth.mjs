/**
 * J8B-BR — short-lived broadcast-only reauthorization for an already-journaled
 * signed EVM tx. Never extends signed-recovery TTL. Never re-signs.
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  MAINNET_IDENTITIES,
  MAINNET_EVM_RPCS,
} from "./identities.mjs";
import {
  CANARY_STATES,
  CANARY_AMOUNT,
  CANARY_TOKEN,
  CANARY_CHAIN_ID,
  CANARY_ASSET_IN,
  CANARY_ASSET_OUT,
  CANARY_ATTESTOR_PK,
  BROADCAST_REAUTH_KIND,
  DEFAULT_BROADCAST_REAUTH_TTL_MS,
  QUOTE_DEADLINE_MIN_REMAINING_MS,
  canaryStoreDir,
  broadcastReauthApprovalPath,
  loadCanaryApproval,
  loadRecoveryAuthorization,
  loadSignedTxRecoveryAuthorization,
  loadBroadcastReauthAuthorization,
  signApprovalPayload,
  getLifecycleState,
  resolveCanaryJournalSecret,
} from "./canaryOneShot.mjs";
import {
  createViewOnlyPolicyAdapters,
  verifyNearProposeReceipt,
} from "./canaryRecovery.mjs";
import { ethJsonRpc } from "./canaryAdapters.mjs";
import { localTxHash, openTxJournal, TX_STATE } from "../execution/txJournal.mjs";
import { getExecutionStatus, normalizeIntentStatus } from "./intents.mjs";
import {
  decodeSignedEip155Tx,
} from "../intents-codec/quote-auth.mjs";
import { recoverFromHash } from "../gate-k/settle.mjs";

const EXPECTED_MPC = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
const EXPECTED_ESCROW = "0xcaa3dc3d6d2bb72ade403c614949e66d5ed37f1e";
const EXPECTED_LOCAL =
  "a4d159fec8eca4e7bed01c6ed3b25e65ded7519dce47f9fd422fb6e9a55c9664";

async function checkArbBroadcastSurface({
  mpc = EXPECTED_MPC,
  expectedNonce = 0,
  localTxHashHex = null,
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
      return { ok: false, reason: "arb_nonce_unreadable" };
    }
    const pendingCount =
      pending != null && !Number.isNaN(pending) ? pending : latest;
    const pendingTxInFlight = pendingCount > latest;

    let byHash = null;
    let receipt = null;
    if (localTxHashHex) {
      // local_tx_hash is sha256 of raw bytes — NOT the keccak tx hash.
      // Caller may also pass keccak broadcast hash separately via deps.
      void localTxHashHex;
    }

    return {
      ok: true,
      mpc_nonce: latest,
      mpc_nonce_pending: pendingCount,
      expected_nonce: Number(expectedNonce),
      pending_tx_in_flight: pendingTxInFlight,
      nonce_available_for_broadcast:
        latest === Number(expectedNonce) && !pendingTxInFlight,
      possible_prior_broadcast: latest > Number(expectedNonce),
      by_hash: byHash,
      receipt,
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
 * Check whether a known EVM keccak tx hash already exists (pending/mined).
 * This is separate from journal local_tx_hash (sha256 of raw bytes).
 */
export async function checkArbExistingTx({
  evmTxHash = null,
  rpcUrl = MAINNET_EVM_RPCS.arbitrum,
  eth = null,
} = {}) {
  if (!evmTxHash) {
    return {
      ok: true,
      present: false,
      note: "no_evm_keccak_hash_to_probe",
    };
  }
  const call = eth || ((method, params) => ethJsonRpc(rpcUrl, method, params));
  try {
    const tx = await call("eth_getTransactionByHash", [evmTxHash]);
    const rcpt = await call("eth_getTransactionReceipt", [evmTxHash]);
    const present = Boolean(tx?.result);
    const receipt = rcpt?.result || null;
    if (!present && !receipt) {
      return { ok: true, present: false, mined: false, pending: false };
    }
    if (receipt) {
      return {
        ok: false,
        reason: "arb_tx_already_mined",
        present: true,
        mined: true,
        pending: false,
        receipt_status: receipt.status || null,
        halt_broadcast: true,
      };
    }
    // In mempool / known but no receipt
    return {
      ok: false,
      reason: "arb_tx_already_pending_or_known",
      present: true,
      mined: false,
      pending: true,
      halt_broadcast: true,
    };
  } catch (e) {
    return {
      ok: false,
      reason: "arb_tx_lookup_ambiguous",
      error: String(e.message || e),
      halt_broadcast: true,
    };
  }
}

function verifyJournalSignedBytes({
  journal,
  operationId,
  expectedLocalTxHash,
  expectedDigest,
  expectedDeposit,
  expectedNonce,
  expectedGasPrice,
  expectedGasLimit,
  expectedMpc = EXPECTED_MPC,
}) {
  if (!journal) return { ok: false, reason: "journal_missing" };
  const row = journal.get(operationId);
  if (!row) return { ok: false, reason: "journal_entry_missing" };
  if (row.state !== TX_STATE.SIGNED && row.state !== TX_STATE.BROADCAST_PENDING) {
    return { ok: false, reason: `journal_bad_state:${row.state}` };
  }
  if (row.broadcast_hash) {
    return {
      ok: false,
      reason: "journal_already_has_broadcast_hash",
      broadcast_hash: row.broadcast_hash,
    };
  }
  const raw = journal.loadSignedRaw(operationId);
  if (!raw) return { ok: false, reason: "journal_signed_bytes_missing" };
  const hash = localTxHash(raw).toLowerCase();
  const want = String(expectedLocalTxHash || "").toLowerCase();
  if (!want || hash !== want) {
    return {
      ok: false,
      reason: "journal_local_tx_hash_mismatch",
      got: hash,
      expected: want,
    };
  }
  if (
    row.local_tx_hash &&
    String(row.local_tx_hash).toLowerCase() !== want
  ) {
    return {
      ok: false,
      reason: "journal_recorded_hash_mismatch",
      got: row.local_tx_hash,
      expected: want,
    };
  }

  let decoded;
  try {
    decoded = decodeSignedEip155Tx(raw, {
      recoverFn: (digest, r, s, recoveryId) => {
        let addr = recoverFromHash(digest, r, s, recoveryId);
        if (addr.toLowerCase() !== expectedMpc) {
          const alt = recoverFromHash(digest, r, s, recoveryId ^ 1);
          if (alt.toLowerCase() === expectedMpc) addr = alt;
        }
        return addr;
      },
    });
  } catch (e) {
    return {
      ok: false,
      reason: "journal_raw_decode_failed",
      error: String(e.message || e),
    };
  }
  if (!decoded?.ok) {
    return { ok: false, reason: decoded?.reason || "journal_raw_verify_failed" };
  }

  if (
    String(decoded.recovered || "").toLowerCase() !== expectedMpc
  ) {
    return {
      ok: false,
      reason: "journal_recovered_signer_mismatch",
      got: decoded.recovered,
    };
  }
  if (Number(decoded.chainId) !== CANARY_CHAIN_ID) {
    return { ok: false, reason: "journal_chain_id_mismatch", got: decoded.chainId };
  }
  if (Number(decoded.nonce) !== Number(expectedNonce)) {
    return { ok: false, reason: "journal_nonce_mismatch", got: decoded.nonce };
  }
  if (
    String(decoded.to || "").toLowerCase() !==
    String(CANARY_TOKEN).toLowerCase()
  ) {
    return { ok: false, reason: "journal_token_mismatch", got: decoded.to };
  }
  if (String(decoded.gasPrice) !== String(expectedGasPrice)) {
    return { ok: false, reason: "journal_gas_price_mismatch" };
  }
  if (String(decoded.gasLimit) !== String(expectedGasLimit)) {
    return { ok: false, reason: "journal_gas_limit_mismatch" };
  }
  if (
    expectedDigest &&
    String(decoded.digest_hex || "").toLowerCase() !==
      String(expectedDigest).toLowerCase()
  ) {
    return { ok: false, reason: "journal_digest_mismatch" };
  }
  if (!decoded.transfer) {
    return { ok: false, reason: "journal_not_erc20_transfer" };
  }
  if (
    expectedDeposit &&
    String(decoded.transfer.recipient).toLowerCase() !==
      String(expectedDeposit).toLowerCase()
  ) {
    return {
      ok: false,
      reason: "journal_escrow_mismatch",
      got: decoded.transfer.recipient,
    };
  }
  if (String(decoded.transfer.amount) !== CANARY_AMOUNT) {
    return {
      ok: false,
      reason: "journal_amount_mismatch",
      got: decoded.transfer.amount,
    };
  }

  return {
    ok: true,
    local_tx_hash: hash,
    journal_state: row.state,
    recovered: expectedMpc,
    digest_hex: decoded.digest_hex || expectedDigest,
    raw_present: true,
    decoded_public: {
      chain_id: decoded.chainId,
      nonce: decoded.nonce,
      to: decoded.to,
      gas_price: decoded.gasPrice,
      gas_limit: decoded.gasLimit,
      digest_hex: decoded.digest_hex || null,
      escrow: decoded.transfer.recipient,
      amount: decoded.transfer.amount,
      recovered: expectedMpc,
    },
  };
}

/**
 * READ-ONLY inspection before creating a broadcast-only reauthorization.
 */
export async function inspectBroadcastReauth({
  operationId,
  nearSignTx = null,
  nearProposeTx = null,
  expectedLocalTxHash = EXPECTED_LOCAL,
  env = process.env,
  storeDir = null,
  adapters = null,
  testHarness = false,
  deps = {},
} = {}) {
  if (!operationId) return { ok: false, reason: "operation_id_required" };

  const a =
    adapters ||
    deps.adapters ||
    (testHarness ? null : await createViewOnlyPolicyAdapters({ env }));
  if (!a?.getPending || !a?.getPaused) {
    return { ok: false, reason: "view_adapters_missing" };
  }

  const original = loadCanaryApproval(operationId, { env, storeDir });
  const priorRecovery = loadRecoveryAuthorization(operationId, {
    env,
    storeDir,
  });
  const signedRecovery = loadSignedTxRecoveryAuthorization(operationId, {
    env,
    storeDir,
  });
  const existingReauth = loadBroadcastReauthAuthorization(operationId, {
    env,
    storeDir,
  });

  const paused = await a.getPaused();
  const epoch = await a.getMandateEpoch();
  const pending = deps.pending || (await a.getPending(operationId));

  const wantDigest = original.ok
    ? String(original.record.locked_digest_hex || "").toLowerCase()
    : null;
  const deposit = original.ok
    ? String(original.record.payload.deposit_address || "").toLowerCase()
    : EXPECTED_ESCROW;
  const signTx =
    nearSignTx ||
    (signedRecovery.ok ? signedRecovery.record.payload.near_sign_tx : null);
  const proposeTx =
    nearProposeTx ||
    (signedRecovery.ok ? signedRecovery.record.payload.near_propose_tx : null);

  // Journal
  let journal = deps.journal || null;
  if (!journal) {
    const sec = resolveCanaryJournalSecret({ env, storeDir });
    if (sec.ok) {
      const journalPath =
        deps.journalPath ||
        join(
          storeDir || canaryStoreDir(env) || join(homedir(), ".nio-secure", "mainnet-canary"),
          "tx-journal.sqlite"
        );
      journal = openTxJournal({ path: journalPath, secret: sec.secret });
    }
  }
  const wantLocal =
    expectedLocalTxHash ||
    signedRecovery.record?.locked_local_tx_hash ||
    signedRecovery.record?.payload?.local_tx_hash ||
    EXPECTED_LOCAL;

  const journalCheck =
    deps.journalVerify ||
    verifyJournalSignedBytes({
      journal,
      operationId,
      expectedLocalTxHash: wantLocal,
      expectedDigest: wantDigest,
      expectedDeposit: deposit,
      expectedNonce: original.ok ? original.record.locked_nonce : 0,
      expectedGasPrice: original.ok
        ? original.record.locked_gas_price
        : "30000000",
      expectedGasLimit: original.ok
        ? original.record.locked_gas_limit
        : "100000",
    });

  const arb =
    deps.arbNonce ||
    (await checkArbBroadcastSurface({
      expectedNonce: original.ok ? Number(original.record.locked_nonce) : 0,
      eth: deps.eth || null,
    }));
  const arbTx =
    deps.arbExistingTx ||
    (await checkArbExistingTx({
      evmTxHash: deps.evmTxHash || null,
      eth: deps.eth || null,
    }));

  let proposeReceipt = deps.proposeReceiptVerify || null;
  if (proposeTx && !proposeReceipt) {
    if (a.waitNearTx) {
      try {
        const full = await a.waitNearTx(proposeTx);
        proposeReceipt = verifyNearProposeReceipt(full, {
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

  // Quote / deposit acceptance
  const quoteOutcome =
    (signedRecovery.ok &&
      signedRecovery.record.outcomes?.[CANARY_STATES.QUOTE_VERIFIED]) ||
    (original.ok &&
      original.record.outcomes?.[CANARY_STATES.QUOTE_VERIFIED]) ||
    {};
  const quote_deadline_ms =
    quoteOutcome.quote_deadline_ms ??
    (signedRecovery.ok
      ? signedRecovery.record.payload.quote_deadline_ms
      : null) ??
    null;
  const min_out = String(
    quoteOutcome.min_out ||
      (signedRecovery.ok
        ? signedRecovery.record.payload.min_amount_out
        : null) ||
      "994904"
  );
  const nowMs = deps.nowMs || Date.now();
  const quoteFresh =
    quote_deadline_ms != null &&
    Number(quote_deadline_ms) - nowMs > QUOTE_DEADLINE_MIN_REMAINING_MS;

  let quoteStatus = deps.quoteStatus || null;
  if (!quoteStatus && deposit && !testHarness) {
    try {
      quoteStatus = await getExecutionStatus(deposit);
    } catch (e) {
      quoteStatus = {
        ok: false,
        reason: "quote_status_fetch_failed",
        error: String(e.message || e),
      };
    }
  }
  if (!quoteStatus && testHarness) {
    quoteStatus = deps.quoteStatus || {
      ok: true,
      normalized: "PENDING",
      status: "PENDING_DEPOSIT",
    };
  }
  const quoteNorm =
    quoteStatus?.normalized ||
    normalizeIntentStatus(quoteStatus?.status || quoteStatus?.body);
  const quoteExecutable =
    quoteStatus?.ok === true &&
    !["SUCCESS", "FAILED", "REFUNDED"].includes(String(quoteNorm));

  const epochMandateOk = Number(epoch) === 2;
  const epochPendingOk = Number(pending?.epoch) === 2;

  const signedRecoveryFingerprint = signedRecovery.ok
    ? signedRecovery.record.fingerprint
    : null;
  const signedRecoveryExpired = signedRecovery.ok
    ? Date.parse(signedRecovery.record.payload.expires_at) <= nowMs
    : null;

  const checks = {
    pending_exists: Boolean(pending),
    signing_signed: String(pending?.signing_state) === "Signed",
    settlement_none:
      String(pending?.settlement_state || "") === "None" ||
      pending?.settlement_state === "",
    epoch_mandate_match: epochMandateOk,
    epoch_pending_match: epochPendingOk,
    epoch_match: epochMandateOk && epochPendingOk,
    digest_match: wantDigest
      ? String(pending?.payload_commitment || "").toLowerCase() === wantDigest
      : false,
    deposit_match:
      String(pending?.destination || "").toLowerCase() === deposit,
    policy_paused: paused === true,
    propose_receipt_ok: !proposeTx || proposeReceipt?.ok === true,
    journal_ok: journalCheck.ok === true,
    journal_local_tx_hash_match:
      journalCheck.ok &&
      String(journalCheck.local_tx_hash).toLowerCase() ===
        String(wantLocal).toLowerCase(),
    arb_nonce_ok: arb.ok === true && arb.nonce_available_for_broadcast === true,
    arb_existing_tx_clear: arbTx.ok === true && arbTx.halt_broadcast !== true,
    quote_deadline_fresh: Boolean(quoteFresh),
    quote_executable: Boolean(quoteExecutable),
    min_out_bound: min_out === "994904" || Boolean(min_out),
    original_immutable_failed:
      original.ok &&
      original.record.used === true &&
      getLifecycleState(original.record) === CANARY_STATES.FAILED,
    prior_recovery_immutable:
      !priorRecovery.ok ||
      getLifecycleState(priorRecovery.record) === CANARY_STATES.FAILED,
    signed_recovery_present_unchanged: signedRecovery.ok === true,
    broadcast_reauth_absent: !existingReauth.ok,
    no_local_broadcast_hash:
      (!original.ok || !original.record.locked_broadcast_hash) &&
      (!signedRecovery.ok || !signedRecovery.record.locked_broadcast_hash),
  };

  const safe =
    checks.pending_exists &&
    checks.signing_signed &&
    checks.settlement_none &&
    checks.epoch_match &&
    checks.digest_match &&
    checks.deposit_match &&
    checks.policy_paused &&
    checks.propose_receipt_ok &&
    checks.journal_ok &&
    checks.journal_local_tx_hash_match &&
    checks.arb_nonce_ok &&
    checks.arb_existing_tx_clear &&
    checks.quote_deadline_fresh &&
    checks.quote_executable &&
    checks.original_immutable_failed &&
    checks.signed_recovery_present_unchanged &&
    checks.broadcast_reauth_absent &&
    checks.no_local_broadcast_hash;

  return {
    ok: true,
    read_only: true,
    mutations_invoked: false,
    operation_id: operationId,
    near_sign_tx: signTx,
    near_propose_tx: proposeTx,
    policy_paused_onchain: paused === true,
    mandate_epoch: epoch,
    pending: pending
      ? {
          epoch: pending.epoch,
          signing_state: pending.signing_state,
          settlement_state: pending.settlement_state,
          payload_commitment: pending.payload_commitment,
          destination: pending.destination,
        }
      : null,
    journal: journalCheck.ok
      ? {
          ok: true,
          local_tx_hash: journalCheck.local_tx_hash,
          journal_state: journalCheck.journal_state,
          recovered: journalCheck.recovered,
          digest_hex: journalCheck.digest_hex,
          decoded: journalCheck.decoded_public,
        }
      : journalCheck,
    arb_nonce: arb,
    arb_existing_tx: arbTx,
    propose_receipt: proposeReceipt,
    quote: {
      deadline_ms: quote_deadline_ms,
      fresh: quoteFresh,
      min_out,
      deposit,
      status_normalized: quoteNorm || null,
      executable: quoteExecutable,
    },
    local_original: original.ok
      ? {
          used: original.record.used,
          lifecycle_state: getLifecycleState(original.record),
          fingerprint: original.record.fingerprint,
          path: original.path,
        }
      : null,
    prior_recovery: priorRecovery.ok
      ? {
          lifecycle_state: getLifecycleState(priorRecovery.record),
          fingerprint: priorRecovery.record.fingerprint,
          path: priorRecovery.path,
        }
      : null,
    signed_recovery: signedRecovery.ok
      ? {
          lifecycle_state: getLifecycleState(signedRecovery.record),
          expires_at: signedRecovery.record.payload.expires_at,
          expired: signedRecoveryExpired,
          fingerprint: signedRecoveryFingerprint,
          local_tx_hash: signedRecovery.record.locked_local_tx_hash,
          path: signedRecovery.path,
          note: "Immutable reference only — never renewed or extended",
        }
      : null,
    broadcast_reauth_exists: existingReauth.ok,
    checks,
    safe_to_create_broadcast_reauth: Boolean(safe),
    verdict: safe
      ? "SAFE_TO_CREATE_BROADCAST_REAUTH"
      : "NO-GO",
    note: "Read-only. Does not create auth, unpause, or broadcast. Never request_signature.",
  };
}

/**
 * Create a short-lived broadcast-only reauthorization.
 * Preserves all prior FAILED/signed-recovery records and journal bytes unchanged.
 */
export async function createBroadcastReauthAuthorization({
  operationId,
  nearSignTx = null,
  nearProposeTx = null,
  expectedLocalTxHash = EXPECTED_LOCAL,
  env = process.env,
  storeDir = null,
  adapters = null,
  testHarness = false,
  operatorConfirmed = false,
  ttlMs = DEFAULT_BROADCAST_REAUTH_TTL_MS,
  deps = {},
} = {}) {
  if (!operatorConfirmed) {
    return {
      ok: false,
      reason: "operator_confirm_required:create_broadcast_reauth",
      verdict: "NO-GO",
    };
  }

  const inspect = await inspectBroadcastReauth({
    operationId,
    nearSignTx,
    nearProposeTx,
    expectedLocalTxHash,
    env,
    storeDir,
    adapters,
    testHarness,
    deps,
  });
  if (!inspect.safe_to_create_broadcast_reauth) {
    return {
      ok: false,
      reason: "unsafe_to_create_broadcast_reauth",
      inspect,
      verdict: "NO-GO",
    };
  }

  const original = loadCanaryApproval(operationId, { env, storeDir });
  const prior = loadRecoveryAuthorization(operationId, { env, storeDir });
  const signed = loadSignedTxRecoveryAuthorization(operationId, {
    env,
    storeDir,
  });
  const existing = loadBroadcastReauthAuthorization(operationId, {
    env,
    storeDir,
  });
  if (existing.ok) {
    return {
      ok: false,
      reason: "broadcast_reauth_already_exists",
      path: existing.path,
    };
  }
  if (!original.ok || !signed.ok) {
    return { ok: false, reason: "original_and_signed_recovery_required" };
  }

  // Snapshot prior files for integrity
  const origMac = original.record.mac;
  const signedMac = signed.record.mac;
  const priorMac = prior.ok ? prior.record.mac : null;
  const signedSnap = JSON.stringify(signed.record);

  const dir = storeDir || canaryStoreDir(env);
  mkdirSync(dir, { recursive: true });
  const path = broadcastReauthApprovalPath(operationId, dir);
  if (existsSync(path)) {
    return { ok: false, reason: "broadcast_reauth_already_exists", path };
  }

  const localHash = String(
    inspect.journal.local_tx_hash || expectedLocalTxHash
  ).toLowerCase();
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
    kind: BROADCAST_REAUTH_KIND,
    recovery_of_fingerprint: original.record.fingerprint,
    prior_recovery_fingerprint: prior.ok ? prior.record.fingerprint : null,
    prior_signed_recovery_fingerprint: signed.record.fingerprint,
    near_propose_tx:
      nearProposeTx || signed.record.payload.near_propose_tx || null,
    near_sign_tx: nearSignTx || signed.record.payload.near_sign_tx,
    forbids_propose: true,
    forbids_request_signature: true,
    forbids_resign: true,
    forbids_tx_mutation: true,
    digest_hex: String(original.record.locked_digest_hex).toLowerCase(),
    local_tx_hash: localHash,
    recovered_signer: EXPECTED_MPC,
    quote_deadline_ms: Number(inspect.quote.deadline_ms),
    min_amount_out: String(inspect.quote.min_out),
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
    lifecycle_state: CANARY_STATES.READY_TO_BROADCAST,
    locked_nonce: original.record.locked_nonce,
    locked_digest_hex: String(original.record.locked_digest_hex).toLowerCase(),
    locked_local_tx_hash: localHash,
    locked_broadcast_hash: null,
    locked_gas_price: original.record.locked_gas_price,
    locked_gas_limit: original.record.locked_gas_limit,
    base_usdc_before: original.record.base_usdc_before,
    outcomes: {
      [CANARY_STATES.QUOTE_VERIFIED]: {
        at: new Date().toISOString(),
        quote_hash: original.record.payload.quote_hash,
        deposit: original.record.payload.deposit_address,
        min_out: String(inspect.quote.min_out),
        quote_deadline_ms: Number(inspect.quote.deadline_ms),
        broadcast_reauth: true,
      },
      [CANARY_STATES.READY_TO_BROADCAST]: {
        at: new Date().toISOString(),
        local_tx_hash: localHash,
        near_sign_tx: payload.near_sign_tx,
        prior_signed_recovery_fingerprint: signed.record.fingerprint,
        prior_signed_recovery_expires_at: signed.record.payload.expires_at,
        note: "broadcast_only_reauth_does_not_extend_signed_recovery",
      },
    },
    consumed_phases: {},
    operator_confirmations: {},
    original_approval_path: original.path,
    prior_recovery_path: prior.ok ? prior.path : null,
    prior_signed_recovery_path: signed.path,
  };
  writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });

  // Integrity: prior records unchanged
  const orig2 = loadCanaryApproval(operationId, { env, storeDir });
  const signed2 = loadSignedTxRecoveryAuthorization(operationId, {
    env,
    storeDir,
  });
  if (
    !orig2.ok ||
    orig2.record.mac !== origMac ||
    getLifecycleState(orig2.record) !== CANARY_STATES.FAILED
  ) {
    return { ok: false, reason: "original_integrity_violation" };
  }
  if (
    !signed2.ok ||
    signed2.record.mac !== signedMac ||
    JSON.stringify(signed2.record) !== signedSnap
  ) {
    return { ok: false, reason: "signed_recovery_integrity_violation" };
  }
  if (prior.ok) {
    const prior2 = loadRecoveryAuthorization(operationId, { env, storeDir });
    if (!prior2.ok || prior2.record.mac !== priorMac) {
      return { ok: false, reason: "prior_recovery_integrity_violation" };
    }
  }

  return {
    ok: true,
    path,
    fingerprint,
    operation_id: operationId,
    lifecycle_state: CANARY_STATES.READY_TO_BROADCAST,
    local_tx_hash: localHash,
    expires_at,
    forbids_propose: true,
    forbids_request_signature: true,
    forbids_resign: true,
    forbids_tx_mutation: true,
    mutations_invoked: false,
    broadcast_invoked: false,
    original_immutable: true,
    signed_recovery_immutable: true,
    verdict: "BROADCAST_REAUTH_CREATED",
    next: "confirm --phase broadcast; then broadcast (dry) then broadcast --invoke under separately approved unpause window. Never request_signature.",
    inspect,
  };
}

void readFileSync;
