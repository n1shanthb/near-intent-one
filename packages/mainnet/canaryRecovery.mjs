/**
 * J8B-R — read-only inspection + recovery authorization for already-reserved PendingOps.
 * Never mutates the original consumed approval. Never auto-resubmits propose.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MAINNET_IDENTITIES } from "./identities.mjs";
import {
  CANARY_STATES,
  CANARY_AMOUNT,
  CANARY_TOKEN,
  CANARY_CHAIN_ID,
  CANARY_ASSET_IN,
  CANARY_ASSET_OUT,
  CANARY_ATTESTOR_PK,
  RECOVERY_KIND,
  DEFAULT_APPROVAL_TTL_MS,
  canaryStoreDir,
  recoveryApprovalPath,
  loadCanaryApproval,
  loadRecoveryAuthorization,
  signApprovalPayload,
  getLifecycleState,
} from "./canaryOneShot.mjs";
import { buildReconcileLedgerCommand } from "./canaryLedgerRunbook.mjs";
import { createMainnetCanaryAdapters } from "./canaryAdapters.mjs";
import { MAINNET } from "../networks/profiles.mjs";
import { pickRpc, viewFunction } from "../networks/rpc.mjs";

/** Read-only policy views — no agent credential required. */
export async function createViewOnlyPolicyAdapters(opts = {}) {
  const rpc = opts.rpc || (await pickRpc(MAINNET.near.rpcs));
  const policy = MAINNET_IDENTITIES.policy;
  return {
    kind: "view_only_policy_adapters_v1",
    rpc,
    async getPaused() {
      return Boolean(await viewFunction(rpc, policy, "get_paused", {}));
    },
    async getMandateEpoch() {
      return Number(await viewFunction(rpc, policy, "get_mandate_epoch", {}));
    },
    async getPending(operationId) {
      return viewFunction(rpc, policy, "get_pending", {
        operation_id: operationId,
      });
    },
    async listPending() {
      return viewFunction(rpc, policy, "list_pending", {});
    },
    async waitNearTx(txHash, signerId = MAINNET_IDENTITIES.agent) {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "nio-near-tx",
          method: "EXPERIMENTAL_tx_status",
          params: [txHash, signerId],
        }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || "near_tx_status_failed");
      return j.result || j;
    },
  };
}

/**
 * Independently verify the original NEAR propose receipt.
 * A supplied hash / generic successful tx alone is NOT proof of reservation.
 * Requires a parsed quoted_evm_reserved EVENT_JSON from this tx's outcomes
 * with exact operation_id + digest, plus signer/receiver checks.
 */
export function verifyNearProposeReceipt(nearTxFull, {
  operationId,
  expectedDigest = null,
  expectedSigner = MAINNET_IDENTITIES.agent,
  expectedReceiver = MAINNET_IDENTITIES.policy,
} = {}) {
  if (!nearTxFull) {
    return { ok: false, reason: "near_tx_receipt_missing" };
  }
  if (!operationId) {
    return { ok: false, reason: "operation_id_required" };
  }
  if (!expectedDigest) {
    return { ok: false, reason: "expected_digest_required" };
  }

  const tx = nearTxFull?.transaction || nearTxFull?.result?.transaction || null;
  const signer = tx?.signer_id || null;
  const receiver = tx?.receiver_id || null;
  if (!signer) {
    return { ok: false, reason: "near_tx_signer_missing" };
  }
  if (!receiver) {
    return { ok: false, reason: "near_tx_receiver_missing" };
  }
  if (
    expectedSigner &&
    String(signer) !== String(expectedSigner)
  ) {
    return { ok: false, reason: "near_tx_signer_mismatch", got: signer };
  }
  if (
    expectedReceiver &&
    String(receiver) !== String(expectedReceiver)
  ) {
    return { ok: false, reason: "near_tx_receiver_mismatch", got: receiver };
  }

  const receiptsOutcome = [
    ...(nearTxFull?.receipts_outcome || []),
    ...(nearTxFull?.result?.receipts_outcome || []),
  ];
  const txOutcome =
    nearTxFull?.transaction_outcome || nearTxFull?.result?.transaction_outcome;
  const status =
    txOutcome?.outcome?.status ||
    nearTxFull?.status ||
    nearTxFull?.result?.status;
  const success =
    status?.SuccessValue != null ||
    status?.SuccessReceiptId != null ||
    (typeof status === "string" && /success/i.test(status));
  if (!success) {
    return { ok: false, reason: "near_tx_not_successful", status };
  }

  // Only logs belonging to this transaction's execution outcomes.
  const outcomeNodes = [];
  if (txOutcome) outcomeNodes.push(txOutcome);
  for (const r of receiptsOutcome) outcomeNodes.push(r);

  const reservedEvents = [];
  let malformedReserved = false;
  for (const node of outcomeNodes) {
    const logs = node?.outcome?.logs || [];
    for (const l of logs) {
      const s = String(l);
      if (!s.startsWith("EVENT_JSON:")) continue;
      let j;
      try {
        j = JSON.parse(s.slice("EVENT_JSON:".length));
      } catch {
        continue;
      }
      if (j?.event !== "quoted_evm_reserved") continue;
      const eventOp = j.operation_id ?? null;
      const eventDigest = j.digest ?? null;
      if (!eventOp || !eventDigest) {
        malformedReserved = true;
        continue;
      }
      reservedEvents.push({
        operation_id: String(eventOp),
        digest: String(eventDigest).toLowerCase(),
      });
    }
  }

  if (malformedReserved && reservedEvents.length === 0) {
    return { ok: false, reason: "quoted_evm_reserved_malformed" };
  }
  if (reservedEvents.length === 0) {
    return { ok: false, reason: "quoted_evm_reserved_not_found_in_receipt" };
  }

  const ops = new Set(reservedEvents.map((e) => e.operation_id));
  const digests = new Set(reservedEvents.map((e) => e.digest));
  if (ops.size !== 1 || digests.size !== 1) {
    return { ok: false, reason: "quoted_evm_reserved_conflicting_events" };
  }

  const eventOp = reservedEvents[0].operation_id;
  const eventDigest = reservedEvents[0].digest;
  if (String(eventOp) !== String(operationId)) {
    return {
      ok: false,
      reason: "near_receipt_operation_id_mismatch",
      got: eventOp,
    };
  }
  if (eventDigest !== String(expectedDigest).toLowerCase()) {
    return {
      ok: false,
      reason: "near_receipt_digest_mismatch",
      got: eventDigest,
    };
  }

  return {
    ok: true,
    independently_verified: true,
    operation_id: eventOp,
    digest: eventDigest,
    has_quoted_evm_reserved: true,
    signer_id: signer,
    receiver_id: receiver,
  };
}

function u128ToString(v) {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") {
    return String(v);
  }
  if (typeof v === "object") {
    if (v[""] != null) return String(v[""]);
    if (v.toString && v.toString !== Object.prototype.toString) {
      return String(v.toString());
    }
  }
  return String(v);
}

function normalizeSigningState(s) {
  return String(s || "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Bounded retry for get_pending + list_pending cross-check.
 * Null is temporary unverified — NOT a digest mismatch.
 */
export async function waitForPendingOp({
  adapters,
  operationId,
  expectedDigest = null,
  attempts = 8,
  delayMs = 750,
  sleepFn = sleep,
} = {}) {
  let last = null;
  let listed = null;
  for (let i = 0; i < attempts; i++) {
    last = await adapters.getPending(operationId);
    if (last?.payload_commitment) {
      if (
        expectedDigest &&
        String(last.payload_commitment).toLowerCase() !==
          String(expectedDigest).toLowerCase()
      ) {
        return {
          ok: false,
          reason: "payload_commitment_mismatch",
          pending: last,
          attempts: i + 1,
        };
      }
      return {
        ok: true,
        pending: last,
        source: "get_pending",
        attempts: i + 1,
      };
    }
    if (typeof adapters.listPending === "function") {
      listed = await adapters.listPending();
      const hit = (listed || []).find(
        (p) => String(p.operation_id) === String(operationId)
      );
      if (hit?.payload_commitment) {
        if (
          expectedDigest &&
          String(hit.payload_commitment).toLowerCase() !==
            String(expectedDigest).toLowerCase()
        ) {
          return {
            ok: false,
            reason: "payload_commitment_mismatch",
            pending: hit,
            source: "list_pending",
            attempts: i + 1,
          };
        }
        return {
          ok: true,
          pending: hit,
          source: "list_pending",
          attempts: i + 1,
        };
      }
    }
    if (i < attempts - 1) await sleepFn(delayMs);
  }
  return {
    ok: false,
    reason: "pending_op_temporarily_unverified",
    pending: last,
    list_pending: listed,
    attempts,
    note: "Do not treat as digest mismatch; do not resubmit propose",
  };
}

/**
 * READ-ONLY inspection of an on-chain reserved operation.
 */
export async function inspectReservedOperation({
  operationId,
  nearProposeTx = null,
  expectedDigest = null,
  expectedDeposit = null,
  expectedAmount = CANARY_AMOUNT,
  expectedEpoch = 2,
  env = process.env,
  storeDir = null,
  adapters = null,
  testHarness = false,
  deps = {},
} = {}) {
  let a = adapters || deps.adapters || null;
  if (!a && !testHarness) {
    try {
      a = await createViewOnlyPolicyAdapters({ env });
    } catch {
      a = await createMainnetCanaryAdapters({ env });
    }
  }
  if (!a?.getPending || !a?.getPaused) {
    return { ok: false, reason: "adapters_required_for_inspect" };
  }

  const paused = await a.getPaused();
  const epoch = await a.getMandateEpoch();
  const pending =
    deps.pending !== undefined
      ? deps.pending
      : await a.getPending(operationId);
  const listed =
    deps.listPending !== undefined
      ? deps.listPending
      : typeof a.listPending === "function"
        ? await a.listPending()
        : null;
  const fromList = (listed || []).find(
    (p) => String(p.operation_id) === String(operationId)
  );
  const op = pending || fromList || null;

  let nearTx = deps.nearTx || null;
  if (!nearTx && nearProposeTx && a.waitNearTx) {
    try {
      nearTx = await a.waitNearTx(nearProposeTx);
    } catch (e) {
      nearTx = { fetch_error: String(e.message || e) };
    }
  }

  const original = loadCanaryApproval(operationId, { env, storeDir });
  const recovery = loadRecoveryAuthorization(operationId, { env, storeDir });

  const digest = op?.payload_commitment
    ? String(op.payload_commitment).toLowerCase()
    : null;
  const wantDigest = expectedDigest
    ? String(expectedDigest).toLowerCase()
    : original.ok
      ? String(original.record.locked_digest_hex || "").toLowerCase()
      : null;
  const deposit = op?.destination
    ? String(op.destination).toLowerCase()
    : null;
  const wantDeposit = expectedDeposit
    ? String(expectedDeposit).toLowerCase()
    : original.ok
      ? String(original.record.payload?.deposit_address || "").toLowerCase()
      : null;
  const amount = u128ToString(op?.amount_in);
  const signing = normalizeSigningState(op?.signing_state);
  const settlement = String(op?.settlement_state || "");

  const receiptCheck =
    deps.nearReceiptVerify ||
    verifyNearProposeReceipt(nearTx, {
      operationId,
      expectedDigest: wantDigest,
    });

  const checks = {
    pending_exists: Boolean(op),
    digest_match: wantDigest ? digest === wantDigest : null,
    epoch_match: Number(op?.epoch) === Number(expectedEpoch),
    amount_match: amount === String(expectedAmount),
    deposit_match: wantDeposit ? deposit === wantDeposit : null,
    signing_reserved: signing === "Reserved",
    settlement_none: settlement === "None" || settlement === "",
    policy_paused: paused === true,
    no_local_broadcast:
      !original.ok || original.record.locked_broadcast_hash == null,
    no_mpc_signed_local:
      !original.ok ||
      ![CANARY_STATES.MPC_SIGNED, CANARY_STATES.READY_TO_BROADCAST].includes(
        getLifecycleState(original.record)
      ),
    original_immutable_used: original.ok ? original.record.used === true : null,
    near_propose_receipt_verified: receiptCheck.ok === true,
  };

  const safeToRecover =
    checks.pending_exists &&
    checks.digest_match !== false &&
    checks.epoch_match &&
    checks.amount_match &&
    checks.deposit_match !== false &&
    checks.signing_reserved &&
    checks.settlement_none &&
    checks.policy_paused &&
    checks.no_local_broadcast &&
    checks.original_immutable_used === true &&
    checks.near_propose_receipt_verified &&
    signing !== "Signed" &&
    signing !== "Signing";

  const abortPath = buildReconcileLedgerCommand({
    operationId,
    settlementState: "Failed",
    evidenceHash: createHash("sha256")
      .update(
        JSON.stringify({
          operation_id: operationId,
          reason: "abort_unresolved_reservation",
          near_propose_tx: nearProposeTx,
          digest: digest || wantDigest,
        })
      )
      .digest("hex"),
    argsDir: storeDir || join(homedir(), ".nio-secure", "mainnet-canary"),
  });

  return {
    ok: true,
    read_only: true,
    operation_id: operationId,
    policy_paused_onchain: paused,
    mandate_epoch: epoch,
    pending: op,
    list_hit: fromList || null,
    near_propose_tx: nearProposeTx,
    near_tx_present: Boolean(nearTx) && !nearTx.fetch_error,
    near_receipt: receiptCheck,
    local_original: original.ok
      ? {
          used: original.record.used,
          lifecycle_state: getLifecycleState(original.record),
          consume_reason: original.record.consume_reason || null,
          locked_digest_hex: original.record.locked_digest_hex,
          fingerprint: original.record.fingerprint,
          path: original.path,
        }
      : null,
    recovery_auth_exists: recovery.ok,
    checks,
    safe_to_create_recovery_auth: Boolean(safeToRecover),
    verdict: safeToRecover
      ? "SAFE_TO_RESUME_ORIGINAL_OPERATION"
      : "NO-GO",
    abort_ledger: abortPath,
    note: "No mutations performed. Original approval must remain immutable if used. Hash alone is not proof — receipt verified independently.",
  };
}

/**
 * Create a NEW single-use recovery authorization bound to the same on-chain op + digest.
 * Never flips used=false on the original. Never calls propose.
 */
export async function createRecoveryAuthorization({
  operationId,
  nearProposeTx = null,
  env = process.env,
  storeDir = null,
  adapters = null,
  testHarness = false,
  deps = {},
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
  operatorConfirmed = false,
} = {}) {
  if (!operatorConfirmed) {
    return {
      ok: false,
      reason: "recovery_requires_explicit_operator_confirm",
      note: "Pass operatorConfirmed:true only after reviewing inspect output",
    };
  }

  const original = loadCanaryApproval(operationId, { env, storeDir });
  if (!original.ok) return original;
  if (original.record.used !== true) {
    return {
      ok: false,
      reason: "original_not_consumed",
      note: "Recovery auth is only for already-consumed/false-failed originals",
    };
  }
  // Never mutate original
  const originalSnapshot = {
    path: original.path,
    fingerprint: original.record.fingerprint,
    used: original.record.used,
    lifecycle_state: getLifecycleState(original.record),
    consume_reason: original.record.consume_reason,
    locked_digest_hex: original.record.locked_digest_hex,
  };

  const existing = loadRecoveryAuthorization(operationId, { env, storeDir });
  if (existing.ok) {
    return {
      ok: false,
      reason: "recovery_auth_already_exists",
      path: existing.path,
    };
  }

  const proposeTx =
    nearProposeTx ||
    original.record.outcomes?.[CANARY_STATES.RECONCILIATION_REQUIRED]
      ?.near_tx ||
    original.record.outcomes?.[CANARY_STATES.PROPOSED]?.near_tx ||
    null;
  const inspect = await inspectReservedOperation({
    operationId,
    nearProposeTx: proposeTx,
    expectedDigest: original.record.locked_digest_hex,
    expectedDeposit: original.record.payload.deposit_address,
    env,
    storeDir,
    adapters,
    testHarness,
    deps,
  });
  if (!inspect.safe_to_create_recovery_auth) {
    return {
      ok: false,
      reason: "unsafe_to_create_recovery_auth",
      inspect,
      verdict: "NO-GO",
    };
  }
  if (inspect.policy_paused_onchain !== true) {
    return {
      ok: false,
      reason: "policy_must_be_paused_before_recovery_auth",
      inspect,
    };
  }

  const dir = storeDir || canaryStoreDir(env);
  mkdirSync(dir, { recursive: true });
  const path = recoveryApprovalPath(operationId, dir);
  if (existsSync(path)) {
    return { ok: false, reason: "recovery_auth_already_exists", path };
  }

  const qv = original.record.outcomes?.[CANARY_STATES.QUOTE_VERIFIED] || {};
  const at = original.record.outcomes?.[CANARY_STATES.ATTESTED] || {};
  const quote_deadline_ms =
    qv.quote_deadline_ms ?? at.quote_deadline_ms ?? null;
  const min_amount_out = String(qv.min_out || at.min_out || "");
  const recipient =
    at.propose_args?.attestation?.recipient ||
    MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
  const refund_to =
    at.propose_args?.attestation?.refund_to ||
    MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();

  if (quote_deadline_ms == null || !min_amount_out) {
    return {
      ok: false,
      reason: "original_quote_economics_missing",
      note: "Cannot recover without verified quote deadline and min_amount_out",
    };
  }

  const expires_at = new Date(Date.now() + ttlMs).toISOString();
  // Both auth TTL and original 1Click deadline remain enforced.
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
    mpc: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
    attestor_public_key: CANARY_ATTESTOR_PK,
    max_gas_price: String(original.record.payload.max_gas_price),
    max_slippage_bps: Number(original.record.payload.max_slippage_bps),
    quote_hash: original.record.payload.quote_hash,
    deposit_address: String(original.record.payload.deposit_address).toLowerCase(),
    expires_at,
    kind: RECOVERY_KIND,
    recovery_of_fingerprint: original.record.fingerprint,
    near_propose_tx: proposeTx,
    forbids_propose: true,
    digest_hex: String(original.record.locked_digest_hex).toLowerCase(),
    quote_deadline_ms: Number(quote_deadline_ms),
    min_amount_out,
    recipient: String(recipient).toLowerCase(),
    refund_to: String(refund_to).toLowerCase(),
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
    lifecycle_state: CANARY_STATES.PROPOSED,
    locked_nonce: original.record.locked_nonce,
    locked_digest_hex: String(original.record.locked_digest_hex).toLowerCase(),
    locked_local_tx_hash: null,
    locked_broadcast_hash: null,
    locked_gas_price: original.record.locked_gas_price || null,
    locked_gas_limit: original.record.locked_gas_limit || null,
    base_usdc_before: original.record.base_usdc_before,
    outcomes: {
      // Preserve original quote economics for deadline + settlement validators
      [CANARY_STATES.QUOTE_VERIFIED]: {
        at: qv.at || new Date().toISOString(),
        quote_hash: original.record.payload.quote_hash,
        deposit: original.record.payload.deposit_address,
        min_out: min_amount_out,
        quote_deadline_ms: Number(quote_deadline_ms),
        quote_deadline: qv.quote_deadline || null,
        recovered_from_original: true,
      },
      [CANARY_STATES.ATTESTED]: {
        at: at.at || new Date().toISOString(),
        digest_hex: String(original.record.locked_digest_hex).toLowerCase(),
        nonce: original.record.locked_nonce,
        min_out: min_amount_out,
        quote_deadline_ms: Number(quote_deadline_ms),
        propose_args: at.propose_args || null,
        recovered_from_original: true,
      },
      [CANARY_STATES.PROPOSED]: {
        at: new Date().toISOString(),
        recovery: true,
        near_tx: payload.near_propose_tx,
        payload_commitment: inspect.pending.payload_commitment,
        near_receipt: inspect.near_receipt,
        original_snapshot: originalSnapshot,
      },
    },
    consumed_phases: {},
    operator_confirmations: {},
    original_approval_path: original.path,
  };
  writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });

  // Integrity check: original file untouched
  const recheck = loadCanaryApproval(operationId, { env, storeDir });
  if (
    !recheck.ok ||
    recheck.record.used !== true ||
    recheck.record.mac !== original.record.mac
  ) {
    return {
      ok: false,
      reason: "original_integrity_violation",
      note: "Abort — original must remain immutable",
    };
  }

  return {
    ok: true,
    path,
    fingerprint,
    operation_id: operationId,
    lifecycle_state: CANARY_STATES.PROPOSED,
    locked_digest_hex: record.locked_digest_hex,
    forbids_propose: true,
    original_immutable: true,
    verdict: "SAFE_TO_RESUME_ORIGINAL_OPERATION",
    next: "Policy remains paused until separate unpause; CLI confirm --phase sign; never propose again",
    inspect,
  };
}

/**
 * Zero-mutation recovery rehearsal for an incident operation.
 */
export async function runRecoveryRehearsal({
  operationId,
  nearProposeTx = null,
  env = process.env,
  storeDir = null,
  adapters = null,
  testHarness = false,
  deps = {},
} = {}) {
  const inspect = await inspectReservedOperation({
    operationId,
    nearProposeTx,
    env,
    storeDir,
    adapters,
    testHarness,
    deps,
  });
  const recovery = loadRecoveryAuthorization(operationId, { env, storeDir });
  return {
    ok: true,
    mutations_invoked: false,
    stage: "RECOVERY_REHEARSAL_COMPLETE",
    inspect,
    recovery_auth: recovery.ok
      ? { path: recovery.path, used: recovery.record.used, state: getLifecycleState(recovery.record) }
      : null,
    create_recovery_dry: {
      would_require_operatorConfirmed: true,
      would_forbid_propose: true,
      would_start_at: CANARY_STATES.PROPOSED,
    },
    verdict: inspect.verdict,
  };
}

export function assertProposeForbiddenForRecovery(record) {
  if (record?.payload?.kind === RECOVERY_KIND || record?.payload?.forbids_propose) {
    return { ok: false, reason: "propose_forbidden_on_recovery_auth" };
  }
  return { ok: true };
}

void randomBytes;
