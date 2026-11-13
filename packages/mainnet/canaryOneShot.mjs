/**
 * J8B-0 — single-use mainnet canary approval.
 * Env vars alone NEVER authorize. One approval = one operation attempt.
 * Store lives outside the repo under ~/.nio-secure/mainnet-canary/.
 */
import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MAINNET_IDENTITIES } from "./identities.mjs";
import { ARBITRUM_NATIVE_USDC, ARBITRUM_CHAIN_ID } from "./arbitrumFunding.mjs";

export const CANARY_AMOUNT = "1000000";
export const CANARY_CHAIN_ID = ARBITRUM_CHAIN_ID;
export const CANARY_TOKEN = ARBITRUM_NATIVE_USDC.toLowerCase();
export const CANARY_ASSET_IN =
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
export const CANARY_ASSET_OUT =
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const CANARY_ATTESTOR_PK =
  "ed25519:6oqnd5mBShyMGGHCgrJEEEPtgAEsXzJEPfARf7Fc2CG9";
export const DEFAULT_MAX_GAS_PRICE = "100000000";
export const DEFAULT_APPROVAL_TTL_MS = 30 * 60_000;

/** Sequential lifecycle — each mutation requires a NEW confirm after prior outcome. */
export const CANARY_STATES = Object.freeze({
  PREPARED: "PREPARED",
  QUOTE_VERIFIED: "QUOTE_VERIFIED",
  ATTESTED: "ATTESTED",
  OWNER_UNPAUSED: "OWNER_UNPAUSED",
  PROPOSED: "PROPOSED",
  MPC_SIGNED: "MPC_SIGNED",
  READY_TO_BROADCAST: "READY_TO_BROADCAST",
  BROADCASTED: "BROADCASTED",
  SETTLEMENT_PENDING: "SETTLEMENT_PENDING",
  SETTLED: "SETTLED",
  RECONCILED: "RECONCILED",
  REFUNDED: "REFUNDED",
  FAILED: "FAILED",
  /** Propose submitted but on-chain PendingOp not yet verified — never auto-resubmit. */
  RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
});

const ALLOWED_TRANSITIONS = Object.freeze({
  PREPARED: ["QUOTE_VERIFIED", "FAILED"],
  QUOTE_VERIFIED: ["ATTESTED", "FAILED"],
  ATTESTED: ["OWNER_UNPAUSED", "FAILED"],
  OWNER_UNPAUSED: ["PROPOSED", "FAILED", "RECONCILIATION_REQUIRED"],
  PROPOSED: ["MPC_SIGNED", "FAILED"],
  MPC_SIGNED: ["READY_TO_BROADCAST", "FAILED"],
  READY_TO_BROADCAST: ["BROADCASTED", "FAILED"],
  BROADCASTED: ["SETTLEMENT_PENDING", "FAILED"],
  SETTLEMENT_PENDING: ["SETTLED", "REFUNDED", "FAILED"],
  SETTLED: ["RECONCILED"],
  RECONCILED: [],
  REFUNDED: [],
  FAILED: [],
  RECONCILIATION_REQUIRED: ["PROPOSED", "FAILED"],
});

export const RECOVERY_KIND = "one_shot_mainnet_canary_recovery_v1";

export function canaryStoreDir(env = process.env) {
  return (
    env.NIO_CANARY_STORE_DIR ||
    join(homedir(), ".nio-secure", "mainnet-canary")
  );
}

/**
 * Private journal encryption/auth secret — never a fixed production fallback.
 * Prefers NIO_JOURNAL_SECRET; else loads/creates a 32-byte file under the canary store.
 */
export function resolveCanaryJournalSecret({
  env = process.env,
  storeDir = null,
} = {}) {
  const fromEnv = env.NIO_JOURNAL_SECRET;
  if (fromEnv && String(fromEnv).length >= 32) {
    return { ok: true, secret: String(fromEnv), source: "env" };
  }
  if (fromEnv && String(fromEnv).length > 0 && String(fromEnv).length < 32) {
    return { ok: false, reason: "journal_secret_too_short" };
  }
  const dir = storeDir || canaryStoreDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "journal.secret");
  if (existsSync(path)) {
    const secret = readFileSync(path, "utf8").trim();
    if (secret.length < 32) {
      return { ok: false, reason: "journal_secret_file_too_short", path };
    }
    return { ok: true, secret, source: "file", path };
  }
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(path, secret + "\n", { mode: 0o600 });
  return { ok: true, secret, source: "generated", path };
}

/** Minimum remaining quote deadline margin before broadcast (ms). */
export const QUOTE_DEADLINE_MIN_REMAINING_MS = 60_000;

function approvalPath(operationId, dir) {
  return join(dir, `${operationId}.json`);
}

export function recoveryApprovalPath(operationId, dir) {
  return join(dir, `recovery-${operationId}.json`);
}

function hmacKey(env = process.env) {
  // Local operator machine secret — never env-alone unlock; file-backed preferred.
  const fromEnv = env.NIO_CANARY_HMAC_SECRET;
  if (fromEnv && fromEnv.length >= 32) return Buffer.from(fromEnv, "utf8");
  const keyFile = join(canaryStoreDir(env), "hmac.key");
  if (existsSync(keyFile)) return readFileSync(keyFile);
  mkdirSync(canaryStoreDir(env), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyFile, key, { mode: 0o600 });
  return key;
}

function canonicalPayload(p) {
  return JSON.stringify({
    operation_id: p.operation_id,
    owner: p.owner,
    policy: p.policy,
    agent: p.agent,
    mandate_epoch: Number(p.mandate_epoch),
    chain_id: Number(p.chain_id),
    token: String(p.token).toLowerCase(),
    asset_in: p.asset_in,
    asset_out: p.asset_out,
    amount: String(p.amount),
    mpc: String(p.mpc).toLowerCase(),
    attestor_public_key: p.attestor_public_key,
    max_gas_price: String(p.max_gas_price),
    max_slippage_bps: Number(p.max_slippage_bps),
    quote_hash: p.quote_hash || null,
    deposit_address: p.deposit_address
      ? String(p.deposit_address).toLowerCase()
      : null,
    expires_at: p.expires_at,
  });
}

export function signApprovalPayload(payload, env = process.env) {
  const body = canonicalPayload(payload);
  const mac = createHmac("sha256", hmacKey(env)).update(body).digest("hex");
  return { body, mac, fingerprint: createHash("sha256").update(body).digest("hex") };
}

export function verifyApprovalMac(record, env = process.env) {
  if (!record?.mac || !record?.payload) return false;
  const { mac } = signApprovalPayload(record.payload, env);
  try {
    const a = Buffer.from(mac, "hex");
    const b = Buffer.from(record.mac, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Create a one-shot approval. Quote hash/escrow may be bound later via bindQuote(),
 * but live execution requires them before propose.
 */
export function createCanaryApproval({
  operationId,
  quoteHash = null,
  depositAddress = null,
  maxGasPrice = DEFAULT_MAX_GAS_PRICE,
  maxSlippageBps = 100,
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
  env = process.env,
  storeDir = null,
} = {}) {
  const dir = storeDir || canaryStoreDir(env);
  mkdirSync(dir, { recursive: true });
  const operation_id =
    operationId || `j8b-canary-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const expires_at = new Date(Date.now() + ttlMs).toISOString();
  const payload = {
    operation_id,
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
    max_gas_price: String(maxGasPrice),
    max_slippage_bps: Number(maxSlippageBps),
    quote_hash: quoteHash,
    deposit_address: depositAddress
      ? String(depositAddress).toLowerCase()
      : null,
    expires_at,
    kind: "one_shot_mainnet_canary_v1",
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
    lifecycle_state: CANARY_STATES.PREPARED,
    locked_nonce: null,
    locked_digest_hex: null,
    locked_local_tx_hash: null,
    locked_broadcast_hash: null,
    base_usdc_before: null,
    outcomes: {},
    consumed_phases: {},
    operator_confirmations: {},
  };
  const path = approvalPath(operation_id, dir);
  if (existsSync(path)) throw new Error("operation_id_already_exists");
  writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
  return { ok: true, operation_id, path, fingerprint, expires_at, payload };
}

export function loadCanaryApproval(operationId, { env = process.env, storeDir = null } = {}) {
  const dir = storeDir || canaryStoreDir(env);
  const path = approvalPath(operationId, dir);
  if (!existsSync(path)) return { ok: false, reason: "approval_not_found" };
  const record = JSON.parse(readFileSync(path, "utf8"));
  return { ok: true, record, path };
}

/**
 * Load recovery authorization for an already-consumed original approval.
 * Never mutates the original file.
 */
export function loadRecoveryAuthorization(
  operationId,
  { env = process.env, storeDir = null } = {}
) {
  const dir = storeDir || canaryStoreDir(env);
  const path = recoveryApprovalPath(operationId, dir);
  if (!existsSync(path)) return { ok: false, reason: "recovery_auth_not_found" };
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record?.payload?.kind !== RECOVERY_KIND) {
    return { ok: false, reason: "not_recovery_authorization" };
  }
  return { ok: true, record, path, is_recovery: true };
}

/**
 * Validate either active original approval OR unused recovery authorization.
 * Prefer recovery when preferRecovery=true or original is used.
 */
export function validateExecutableApproval(
  operationId,
  {
    env = process.env,
    storeDir = null,
    nowMs = Date.now(),
    requireQuoteBound = false,
    expected = {},
    preferRecovery = false,
    allowRecovery = true,
  } = {}
) {
  const original = loadCanaryApproval(operationId, { env, storeDir });
  const recovery = allowRecovery
    ? loadRecoveryAuthorization(operationId, { env, storeDir })
    : { ok: false };

  const tryRec =
    preferRecovery ||
    (original.ok && original.record.used === true) ||
    (!original.ok && recovery.ok);

  if (tryRec && recovery.ok) {
    return validateApprovalRecord(recovery.record, {
      operationId,
      env,
      nowMs,
      requireQuoteBound,
      expected,
      path: recovery.path,
      is_recovery: true,
    });
  }
  if (!original.ok) return original;
  return validateApprovalRecord(original.record, {
    operationId,
    env,
    nowMs,
    requireQuoteBound,
    expected,
    path: original.path,
    is_recovery: false,
  });
}

function validateApprovalRecord(
  record,
  { operationId, env, nowMs, requireQuoteBound, expected, path, is_recovery }
) {
  if (!verifyApprovalMac(record, env)) {
    return { ok: false, reason: "approval_mac_invalid" };
  }
  if (record.used) return { ok: false, reason: "approval_already_used" };
  const p = record.payload;
  if (Date.parse(p.expires_at) <= nowMs) {
    return { ok: false, reason: "approval_expired" };
  }
  if (String(p.operation_id) !== String(operationId)) {
    return { ok: false, reason: "operation_id_mismatch" };
  }
  const checks = [
    ["owner", p.owner, MAINNET_IDENTITIES.owner],
    ["policy", p.policy, MAINNET_IDENTITIES.policy],
    ["agent", p.agent, MAINNET_IDENTITIES.agent],
    ["mandate_epoch", Number(p.mandate_epoch), 2],
    ["chain_id", Number(p.chain_id), CANARY_CHAIN_ID],
    ["token", String(p.token).toLowerCase(), CANARY_TOKEN],
    ["amount", String(p.amount), CANARY_AMOUNT],
    ["mpc", String(p.mpc).toLowerCase(), MAINNET_IDENTITIES.mpc_evm_address.toLowerCase()],
    ["asset_in", p.asset_in, CANARY_ASSET_IN],
    ["asset_out", p.asset_out, CANARY_ASSET_OUT],
    ["attestor", p.attestor_public_key, CANARY_ATTESTOR_PK],
  ];
  for (const [name, got, want] of checks) {
    if (got !== want) {
      return { ok: false, reason: `approval_mismatch_${name}`, got, want };
    }
  }
  if (expected.quote_hash && p.quote_hash !== expected.quote_hash) {
    return { ok: false, reason: "approval_quote_hash_mismatch" };
  }
  if (
    expected.deposit_address &&
    String(p.deposit_address).toLowerCase() !==
      String(expected.deposit_address).toLowerCase()
  ) {
    return { ok: false, reason: "approval_deposit_mismatch" };
  }
  if (expected.digest_hex) {
    const locked = String(record.locked_digest_hex || "").toLowerCase();
    if (locked !== String(expected.digest_hex).toLowerCase()) {
      return { ok: false, reason: "approval_digest_mismatch" };
    }
  }
  if (requireQuoteBound && (!p.quote_hash || !p.deposit_address)) {
    return { ok: false, reason: "approval_quote_not_bound" };
  }
  if (is_recovery && p.kind !== RECOVERY_KIND) {
    return { ok: false, reason: "recovery_kind_required" };
  }
  if (is_recovery && p.forbids_propose !== true) {
    return { ok: false, reason: "recovery_must_forbid_propose" };
  }
  return {
    ok: true,
    mode: is_recovery ? "one_shot_canary_recovery" : "one_shot_canary",
    operation_id: operationId,
    payload: p,
    record,
    path,
    is_recovery: Boolean(is_recovery),
  };
}

export function bindQuoteToApproval(
  operationId,
  { quoteHash, depositAddress, env = process.env, storeDir = null }
) {
  const loaded = loadCanaryApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  if (loaded.record.used) return { ok: false, reason: "approval_already_used" };
  const payload = {
    ...loaded.record.payload,
    quote_hash: quoteHash,
    deposit_address: String(depositAddress).toLowerCase(),
  };
  const { mac, fingerprint } = signApprovalPayload(payload, env);
  const next = {
    ...loaded.record,
    payload,
    mac,
    fingerprint,
  };
  atomicWrite(loaded.path, next);
  return { ok: true, record: next };
}

function atomicWrite(path, obj) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Validate original approval only (not recovery). Does not consume.
 */
export function validateCanaryApproval(
  operationId,
  {
    env = process.env,
    storeDir = null,
    nowMs = Date.now(),
    requireQuoteBound = false,
    expected = {},
  } = {}
) {
  const loaded = loadCanaryApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  return validateApprovalRecord(loaded.record, {
    operationId,
    env,
    nowMs,
    requireQuoteBound,
    expected,
    path: loaded.path,
    is_recovery: false,
  });
}

/**
 * Prefer unused recovery auth when original is consumed; else original.
 * Never writes to a used original when recovery exists.
 */
export function resolveWritableApproval(
  operationId,
  { env = process.env, storeDir = null } = {}
) {
  const original = loadCanaryApproval(operationId, { env, storeDir });
  const recovery = loadRecoveryAuthorization(operationId, { env, storeDir });
  if (recovery.ok && recovery.record.used !== true) {
    if (!original.ok || original.record.used === true) {
      return { ...recovery, is_recovery: true };
    }
  }
  if (original.ok) return { ...original, is_recovery: false };
  if (recovery.ok) return { ...recovery, is_recovery: true };
  return original.ok === false ? original : { ok: false, reason: "approval_not_found" };
}

export function recordOperatorConfirmation(
  operationId,
  phase,
  { env = process.env, storeDir = null, confirmed = true, note = null } = {}
) {
  const loaded = resolveWritableApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  if (!confirmed) return { ok: false, reason: "operator_denied" };
  const next = {
    ...loaded.record,
    operator_confirmations: {
      ...loaded.record.operator_confirmations,
      [phase]: {
        at: new Date().toISOString(),
        note: note || null,
      },
    },
  };
  atomicWrite(loaded.path, next);
  return { ok: true, phase, record: next, is_recovery: loaded.is_recovery };
}

export function requireOperatorConfirmation(record, phase) {
  if (!record?.operator_confirmations?.[phase]) {
    return { ok: false, reason: `operator_confirm_required:${phase}` };
  }
  return { ok: true };
}

/** Mark approval fully consumed after terminal success or hard fail-close. */
export function consumeCanaryApproval(
  operationId,
  { env = process.env, storeDir = null, reason = "consumed" } = {}
) {
  const loaded = resolveWritableApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  if (loaded.record.used) return { ok: false, reason: "approval_already_used" };
  const next = {
    ...loaded.record,
    used: true,
    used_at: new Date().toISOString(),
    consume_reason: reason,
  };
  atomicWrite(loaded.path, next);
  return { ok: true, record: next };
}

/**
 * Build canary unlock context for safety gates / broadcast.
 * Env flags are ignored; only a validated approval unlocks.
 * Callers of broadcast MUST pass operationId so the gate re-loads from disk.
 */
export function buildCanaryUnlockContext(operationId, opts = {}) {
  const v = validateCanaryApproval(operationId, opts);
  if (!v.ok) return v;
  return {
    ok: true,
    mode: "one_shot_canary",
    operation_id: operationId,
    payload: v.payload,
    allows_sign: true,
    allows_broadcast: true,
    funded_trading: true, // scoped — does NOT flip global gates
    mainnet_broadcast_enabled: true,
    autonomous_execution_enabled: false,
  };
}

export function getLifecycleState(record) {
  return record?.lifecycle_state || CANARY_STATES.PREPARED;
}

export function advanceLifecycle(
  operationId,
  toState,
  { env = process.env, storeDir = null, outcome = null } = {}
) {
  const loaded = resolveWritableApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  const from = getLifecycleState(loaded.record);
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  if (!allowed.includes(toState)) {
    return { ok: false, reason: `invalid_transition:${from}->${toState}` };
  }
  const next = {
    ...loaded.record,
    lifecycle_state: toState,
    outcomes: {
      ...loaded.record.outcomes,
      [toState]: {
        at: new Date().toISOString(),
        ...(outcome || {}),
      },
    },
  };
  atomicWrite(loaded.path, next);
  return { ok: true, from, to: toState, record: next, is_recovery: loaded.is_recovery };
}

/**
 * Confirm a phase only if current lifecycle is the required prior state.
 * Confirmations are NOT accepted up-front for future mutations.
 */
export function confirmPhaseAfterOutcome(
  operationId,
  phase,
  {
    env = process.env,
    storeDir = null,
    requiredState,
    note = null,
  } = {}
) {
  const loaded = resolveWritableApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  const state = getLifecycleState(loaded.record);
  if (requiredState && state !== requiredState) {
    return {
      ok: false,
      reason: `confirm_wrong_state:have=${state}:need=${requiredState}`,
    };
  }
  return recordOperatorConfirmation(operationId, phase, {
    env,
    storeDir,
    confirmed: true,
    note: note || `confirmed_at_state:${state}`,
  });
}

export function bindTxAuthorization(
  operationId,
  {
    nonce,
    digestHex,
    localTxHash = null,
    gasPrice,
    gasLimit,
    env = process.env,
    storeDir = null,
  }
) {
  const loaded = resolveWritableApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  if (loaded.record.used) return { ok: false, reason: "approval_already_used" };
  if (
    loaded.record.locked_nonce != null &&
    Number(loaded.record.locked_nonce) !== Number(nonce)
  ) {
    return { ok: false, reason: "nonce_already_bound_different" };
  }
  if (
    loaded.record.locked_digest_hex &&
    String(loaded.record.locked_digest_hex).toLowerCase() !==
      String(digestHex).toLowerCase()
  ) {
    return { ok: false, reason: "digest_already_bound_different" };
  }
  const payload = {
    ...loaded.record.payload,
    // keep MAC fields; tx locks stored alongside
  };
  const { mac, fingerprint } = signApprovalPayload(payload, env);
  const next = {
    ...loaded.record,
    mac,
    fingerprint,
    locked_nonce: Number(nonce),
    locked_digest_hex: String(digestHex).toLowerCase(),
    locked_local_tx_hash: localTxHash,
    locked_gas_price: String(gasPrice),
    locked_gas_limit: String(gasLimit),
  };
  atomicWrite(loaded.path, next);
  return { ok: true, record: next };
}

export function bindBroadcastHash(
  operationId,
  broadcastHash,
  { env = process.env, storeDir = null } = {}
) {
  const loaded = resolveWritableApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  const next = {
    ...loaded.record,
    locked_broadcast_hash: broadcastHash,
  };
  atomicWrite(loaded.path, next);
  return { ok: true, record: next };
}

export function setBaseUsdcBefore(
  operationId,
  raw,
  { env = process.env, storeDir = null } = {}
) {
  const loaded = loadCanaryApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  const next = { ...loaded.record, base_usdc_before: String(raw) };
  atomicWrite(loaded.path, next);
  return { ok: true, record: next };
}

/** Try claim exclusive execution lock (crash-safe concurrent block). */
export function tryClaimExecution(
  operationId,
  workerId,
  { env = process.env, storeDir = null, ttlMs = 120_000 } = {}
) {
  const loaded = loadCanaryApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  const now = Date.now();
  const claim = loaded.record.execution_claim;
  if (
    claim?.owner &&
    claim.owner !== workerId &&
    Number(claim.until || 0) > now
  ) {
    return { ok: false, reason: "execution_claimed_by_other", claim };
  }
  const next = {
    ...loaded.record,
    execution_claim: { owner: workerId, until: now + ttlMs },
  };
  atomicWrite(loaded.path, next);
  return { ok: true, record: next };
}

export function releaseExecutionClaim(
  operationId,
  workerId,
  { env = process.env, storeDir = null } = {}
) {
  const loaded = loadCanaryApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  if (
    loaded.record.execution_claim?.owner &&
    loaded.record.execution_claim.owner !== workerId
  ) {
    return { ok: false, reason: "not_claim_owner" };
  }
  const next = { ...loaded.record, execution_claim: null };
  atomicWrite(loaded.path, next);
  return { ok: true };
}

export function windowStatusReport({
  policyPausedOnchain = null,
  mpcSignatureOutstanding = false,
  broadcastStatus = "not_sent",
  lifecycle = null,
} = {}) {
  const pausedKnown = typeof policyPausedOnchain === "boolean";
  return {
    policy_paused_onchain: pausedKnown ? policyPausedOnchain : "unknown",
    owner_pause_required: pausedKnown ? policyPausedOnchain === false : true,
    mpc_signature_outstanding: Boolean(mpcSignatureOutstanding),
    broadcast_status: broadcastStatus, // verified | unknown | not_sent
    lifecycle_state: lifecycle,
    note: "Never claim re-paused before on-chain get_paused===true",
  };
}
