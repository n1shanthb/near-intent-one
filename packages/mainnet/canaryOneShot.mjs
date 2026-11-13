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

export function canaryStoreDir(env = process.env) {
  return (
    env.NIO_CANARY_STORE_DIR ||
    join(homedir(), ".nio-secure", "mainnet-canary")
  );
}

function approvalPath(operationId, dir) {
  return join(dir, `${operationId}.json`);
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
    version: 1,
    created_at: new Date().toISOString(),
    payload,
    mac,
    fingerprint,
    used: false,
    used_at: null,
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
 * Validate approval for a phase. Does not consume unless consume=true.
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
  const { record } = loaded;
  if (!verifyApprovalMac(record, env)) {
    return { ok: false, reason: "approval_mac_invalid" };
  }
  if (record.used) return { ok: false, reason: "approval_already_used" };
  const p = record.payload;
  if (Date.parse(p.expires_at) <= nowMs) {
    return { ok: false, reason: "approval_expired" };
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
  if (requireQuoteBound && (!p.quote_hash || !p.deposit_address)) {
    return { ok: false, reason: "approval_quote_not_bound" };
  }
  return {
    ok: true,
    mode: "one_shot_canary",
    operation_id: operationId,
    payload: p,
    record,
    path: loaded.path,
    allows_sign: true,
    allows_broadcast: true,
    note: "Valid only for this operation_id; env alone does not unlock",
  };
}

export function recordOperatorConfirmation(
  operationId,
  phase,
  { env = process.env, storeDir = null, confirmed = true, note = null } = {}
) {
  const loaded = loadCanaryApproval(operationId, { env, storeDir });
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
  return { ok: true, phase, record: next };
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
  const loaded = loadCanaryApproval(operationId, { env, storeDir });
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
