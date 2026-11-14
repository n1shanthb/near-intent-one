/**
 * Mission 2 (Base USDC → NEAR NEP-141 USDC) production execution path.
 * Approvals / propose / sign / broadcast are NEVER auto-invoked here.
 * J8B Arb and Mission 1 Eth constants must not be reused.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MAINNET_IDENTITIES, MAINNET_USDC, MAINNET_EVM_RPCS } from "./identities.mjs";
import {
  M2_BASE_NEAR_USDC,
  M1_ETH_NEAR_USDC,
  NEAR_NATIVE_USDC_CONTRACT,
  assertRouteAssetIsolation,
  assertNotJ8bRoute,
} from "./canaryRouteProfiles.mjs";
import {
  CANARY_CHAIN_ID,
  CANARY_TOKEN,
  CANARY_ASSET_IN,
  CANARY_ASSET_OUT,
  CANARY_ATTESTOR_PK,
  CANARY_STATES,
  signApprovalPayload,
  verifyApprovalMac,
  DEFAULT_APPROVAL_TTL_MS,
} from "./canaryOneShot.mjs";
import { GAS_ASSUMPTIONS } from "./j5_2.quoteScan.mjs";
import {
  verifySourceUsdcTransfer,
  verifyNearNep141Delta,
  monitorOneClickByDeposit,
  settlementRecoverySteps,
} from "./canarySettlement.mjs";
import { openTxJournal, TX_STATE } from "../execution/txJournal.mjs";

export const MISSION2_APPROVAL_KIND = "one_shot_mainnet_mission2_v1";
export const MISSION2_PROFILE_AMOUNT = M2_BASE_NEAR_USDC.amount;
/** Typical live balance-capped trade size (tests / approvals). */
export const MISSION2_LIVE_AMOUNT_CAP = "997398";
/** Default approval amount (profile); live quote may bind balance-capped amount on payload. */
export const MISSION2_AMOUNT = MISSION2_PROFILE_AMOUNT;
export const MISSION2_CHAIN_ID = M2_BASE_NEAR_USDC.source_chain_id;
export const MISSION2_TOKEN = M2_BASE_NEAR_USDC.source_token;
export const MISSION2_ASSET_IN = M2_BASE_NEAR_USDC.asset_in;
export const MISSION2_ASSET_OUT = M2_BASE_NEAR_USDC.asset_out;

export function mission2StoreDir(env = process.env) {
  return env.NIO_MISSION2_STORE_DIR || join(homedir(), ".nio-secure", "mainnet-mission2");
}

function approvalPath(operationId, dir) {
  return join(dir, `${operationId}.json`);
}

function atomicWrite(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function assertMission2Amount(amount) {
  const s = String(amount);
  if (!/^\d+$/.test(s) || BigInt(s) <= 0n) {
    throw new Error("mission2_amount_invalid");
  }
  if (BigInt(s) > BigInt(MISSION2_PROFILE_AMOUNT)) {
    throw new Error("mission2_amount_exceeds_profile_max");
  }
  return s;
}

/** Reject J8B, Eth Mission 1, and Arb bindings on Mission 2 payloads. */
export function assertMission2Bindings(payload) {
  const chain = Number(payload.chain_id);
  if (chain === 1) throw new Error("mission2_must_not_use_eth_chain");
  if (chain === CANARY_CHAIN_ID) throw new Error("mission2_must_not_use_arb_chain");
  if (chain !== MISSION2_CHAIN_ID) throw new Error("mission2_must_use_base_chain");
  const tok = String(payload.token).toLowerCase();
  if (tok === MAINNET_USDC.ethereum.toLowerCase()) {
    throw new Error("mission2_must_not_use_eth_token");
  }
  if (tok === CANARY_TOKEN) throw new Error("mission2_must_not_use_j8b_token");
  assertNotJ8bRoute({
    source_chain_id: payload.chain_id,
    asset_out: payload.asset_out,
  });
  assertRouteAssetIsolation(M2_BASE_NEAR_USDC, {
    token: payload.token,
    assetIn: payload.asset_in,
    assetOut: payload.asset_out,
    chainId: payload.chain_id,
  });
  if (payload.asset_in === CANARY_ASSET_IN || payload.asset_out === CANARY_ASSET_OUT) {
    throw new Error("mission2_must_not_use_j8b_assets");
  }
  if (payload.asset_in === M1_ETH_NEAR_USDC.asset_in) {
    throw new Error("mission2_must_not_use_m1_eth_asset_in");
  }
  if (String(payload.asset_out) === String(M1_ETH_NEAR_USDC.asset_out)) {
    // same NEAR USDC out is OK — only reject wrong source bindings above
  }
  assertMission2Amount(payload.amount);
  return true;
}

export function buildMission2ApprovalPreview({
  quoteHash = null,
  depositAddress = null,
  amount = MISSION2_PROFILE_AMOUNT,
  maxGasPrice = String(GAS_ASSUMPTIONS.base.max_gas_price_wei),
  maxSlippageBps = 50,
  suggestedOperationId = null,
} = {}) {
  const boundAmount = assertMission2Amount(amount);
  const operation_id =
    suggestedOperationId || `m2-canary-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const payload = {
    operation_id,
    owner: MAINNET_IDENTITIES.owner,
    policy: MAINNET_IDENTITIES.policy,
    agent: MAINNET_IDENTITIES.agent,
    mandate_epoch: 2,
    chain_id: MISSION2_CHAIN_ID,
    token: MISSION2_TOKEN,
    asset_in: MISSION2_ASSET_IN,
    asset_out: MISSION2_ASSET_OUT,
    amount: boundAmount,
    mpc: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
    recipient: M2_BASE_NEAR_USDC.recipient,
    refund_to: M2_BASE_NEAR_USDC.refund_to,
    attestor_public_key: CANARY_ATTESTOR_PK,
    max_gas_price: String(maxGasPrice),
    max_slippage_bps: Number(maxSlippageBps),
    quote_hash: quoteHash,
    deposit_address: depositAddress ? String(depositAddress).toLowerCase() : null,
    route_id: M2_BASE_NEAR_USDC.id,
    destination_kind: M2_BASE_NEAR_USDC.destination_kind,
    destination_contract: NEAR_NATIVE_USDC_CONTRACT,
    kind: MISSION2_APPROVAL_KIND,
    note: "PREVIEW ONLY — not persisted; not an authorization",
  };
  assertMission2Bindings(payload);
  return {
    ok: true,
    persisted: false,
    operation_id,
    payload,
    independent_from_j8b: true,
    independent_from_m1_eth: true,
  };
}

export function createMission2CanaryApproval({
  operationId,
  quoteHash = null,
  depositAddress = null,
  amount = MISSION2_PROFILE_AMOUNT,
  maxGasPrice = String(GAS_ASSUMPTIONS.base.max_gas_price_wei),
  maxSlippageBps = 50,
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
  env = process.env,
  storeDir = null,
} = {}) {
  const dir = storeDir || mission2StoreDir(env);
  mkdirSync(dir, { recursive: true });
  const preview = buildMission2ApprovalPreview({
    quoteHash,
    depositAddress,
    amount,
    maxGasPrice,
    maxSlippageBps,
    suggestedOperationId: operationId,
  });
  const expires_at = new Date(Date.now() + ttlMs).toISOString();
  const payload = { ...preview.payload, expires_at, note: undefined };
  delete payload.note;
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
    near_usdc_before: null,
    outcomes: {},
    consumed_phases: {},
    operator_confirmations: {},
  };
  const path = approvalPath(payload.operation_id, dir);
  if (existsSync(path)) throw new Error("operation_id_already_exists");
  writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
  return { ok: true, operation_id: payload.operation_id, path, fingerprint, expires_at, payload };
}

export function validateMission2CanaryApproval(
  operationId,
  { env = process.env, storeDir = null, nowMs = Date.now(), requireQuoteBound = false } = {}
) {
  const dir = storeDir || mission2StoreDir(env);
  const path = approvalPath(operationId, dir);
  if (!existsSync(path)) return { ok: false, reason: "approval_not_found" };
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (!verifyApprovalMac(record, env)) return { ok: false, reason: "approval_mac_invalid" };
  if (record.used) return { ok: false, reason: "approval_already_used" };
  const p = record.payload;
  if (p.kind !== MISSION2_APPROVAL_KIND) return { ok: false, reason: "not_mission2_approval" };
  if (Date.parse(p.expires_at) <= nowMs) return { ok: false, reason: "approval_expired" };
  try {
    assertMission2Bindings(p);
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
  const checks = [
    ["owner", p.owner, MAINNET_IDENTITIES.owner],
    ["policy", p.policy, MAINNET_IDENTITIES.policy],
    ["agent", p.agent, MAINNET_IDENTITIES.agent],
    ["mandate_epoch", Number(p.mandate_epoch), 2],
    ["chain_id", Number(p.chain_id), MISSION2_CHAIN_ID],
    ["token", String(p.token).toLowerCase(), MISSION2_TOKEN],
    ["mpc", String(p.mpc).toLowerCase(), MAINNET_IDENTITIES.mpc_evm_address.toLowerCase()],
    ["asset_in", p.asset_in, MISSION2_ASSET_IN],
    ["asset_out", p.asset_out, MISSION2_ASSET_OUT],
    ["recipient", p.recipient, M2_BASE_NEAR_USDC.recipient],
    ["attestor", p.attestor_public_key, CANARY_ATTESTOR_PK],
  ];
  for (const [name, got, want] of checks) {
    if (got !== want) return { ok: false, reason: `approval_mismatch_${name}`, got, want };
  }
  try {
    assertMission2Amount(p.amount);
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
  if (requireQuoteBound && (!p.quote_hash || !p.deposit_address)) {
    return { ok: false, reason: "approval_quote_not_bound" };
  }
  return {
    ok: true,
    mode: "one_shot_mission2",
    operation_id: operationId,
    payload: p,
    record,
    path,
    amount: String(p.amount),
  };
}

export function buildMission2TransactionPlan({
  quote = null,
  gasEconomics = null,
  nonce = null,
  nearUsdcBefore = null,
  amount = MISSION2_PROFILE_AMOUNT,
} = {}) {
  const mpc = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
  const deposit = quote?.deposit_address || "<funded_1click_deposit_address>";
  const minOut = quote?.min_amount_out || "<policy_floor_cleared_min_out>";
  const amt = assertMission2Amount(amount);
  return {
    mutations_invoked: false,
    independent_operation: true,
    never_reuse: ["j8b-canary-*", "m1-canary-*", "J8B/M1 nonce/quote/auth"],
    steps: [
      {
        step: 1,
        actor: "owner_Ledger",
        chain: "near",
        action: "unpause()",
        receiver: MAINNET_IDENTITIES.policy,
      },
      {
        step: 2,
        actor: "agent",
        chain: "near",
        action: "propose_quoted_evm_transfer",
        receiver: MAINNET_IDENTITIES.policy,
        args_shape: {
          operation_id: "<fresh_m2_operation_id>",
          chain_id: String(MISSION2_CHAIN_ID),
          token_contract: MISSION2_TOKEN,
          to: deposit,
          amount: amt,
          asset_in: MISSION2_ASSET_IN,
          asset_out: MISSION2_ASSET_OUT,
          destination: M2_BASE_NEAR_USDC.recipient,
          min_amount_out: minOut,
          expected_epoch: 2,
        },
      },
      {
        step: 4,
        actor: "mpc_evm",
        chain: "base",
        action: "eth_sendRawTransaction",
        from: mpc,
        to: MISSION2_TOKEN,
        calldata: `ERC20.transfer(depositAddress, ${amt})`,
        nonce,
        explorer: "https://basescan.org/tx/<tx_hash>",
      },
      {
        step: 5,
        actor: "operator_ro",
        action: "settlement_verify",
        checks: [
          `verifySourceUsdcTransfer(chainId=8453, token=Base USDC, amount=${amt})`,
          "monitorOneClickByDeposit → SUCCESS",
          "verifyNearNep141Delta",
        ],
      },
    ],
  };
}

export async function verifyMission2Settlement({
  txHash,
  depositAddress,
  mpc = MAINNET_IDENTITIES.mpc_evm_address,
  recipient = M2_BASE_NEAR_USDC.recipient,
  amount,
  minAmountOut,
  nearUsdcBefore,
  baseRpcUrl = MAINNET_EVM_RPCS.base,
  nearRpcUrl,
  deps = {},
} = {}) {
  const amt = amount != null ? String(amount) : null;
  if (!amt) return { ok: false, reason: "mission2_settlement_amount_required" };
  const source =
    deps.sourceVerify ||
    (await verifySourceUsdcTransfer({
      txHash,
      mpc,
      escrow: depositAddress,
      amount: amt,
      rpcUrl: baseRpcUrl,
      token: MAINNET_USDC.base,
      expectedChainId: MISSION2_CHAIN_ID,
    }));
  if (!source.ok) {
    return {
      ok: false,
      reason: "source_receipt_failed",
      source,
      settlement_recovery: settlementRecoverySteps("FAILED"),
    };
  }
  const settle =
    deps.oneClick ||
    (await monitorOneClickByDeposit({
      depositAddress,
      maxPolls: deps.settlePolls || 3,
      pollFn: deps.oneClickStatus,
    }));
  if (!settle.terminal) {
    return {
      ok: false,
      reason: "settlement_incomplete",
      source,
      settlement: settle,
      settlement_recovery: settlementRecoverySteps(settle.normalized),
    };
  }
  if (settle.normalized !== "SUCCESS") {
    return {
      ok: false,
      reason: `settle_${settle.normalized}`,
      source,
      settlement: settle,
      settlement_recovery: settlementRecoverySteps(settle.normalized),
    };
  }
  if (nearUsdcBefore == null || nearUsdcBefore === "") {
    return { ok: false, reason: "near_usdc_before_missing_refuse_zero_default" };
  }
  const dest =
    deps.nearVerify ||
    (await verifyNearNep141Delta({
      accountId: recipient,
      beforeRaw: nearUsdcBefore,
      minAmountOut,
      tokenContract: NEAR_NATIVE_USDC_CONTRACT,
      rpcUrl: nearRpcUrl,
    }));
  if (!dest.ok) {
    return {
      ok: false,
      reason: "near_usdc_delta_insufficient",
      source,
      settlement: settle,
      destination: dest,
      settlement_recovery: settlementRecoverySteps("PENDING"),
    };
  }
  return {
    ok: true,
    source,
    settlement: settle,
    destination: dest,
    note: "SUCCESS only after Base transfer + 1Click SUCCESS + NEAR NEP-141 delta",
  };
}

export function auditMission2ProductionPath({
  journalFactory = openTxJournal,
  env = process.env,
  runnerAssert = null,
} = {}) {
  const gaps = [];
  const ready = [];

  ready.push("verifySourceUsdcTransfer_parameterized_for_base");
  ready.push("verifyNearNep141Delta_production_nep141");
  ready.push("mission2_settlement_wrapper_wired");
  ready.push("near_usdc_before_snapshot_required");

  let journalOk = false;
  try {
    const dir = join(homedir(), ".nio-secure", "tmp-mission2-audit");
    mkdirSync(dir, { recursive: true });
    const j = journalFactory({
      path: join(dir, `audit-${Date.now()}.sqlite`),
      secret: env.NIO_JOURNAL_SECRET || "mission2-audit-secret-32bytes-min!!",
    });
    const id = `m2-audit-${randomBytes(3).toString("hex")}`;
    j.insertDraft({
      id,
      portfolio_id: "nio-mainnet-v1",
      idempotency_key: id,
      nonce: "0",
      chain_id: String(MISSION2_CHAIN_ID),
      to: MISSION2_TOKEN,
      data_hash: createHash("sha256").update("audit").digest("hex"),
    });
    const draft = j.get(id);
    if (draft?.state !== TX_STATE.DRAFT) gaps.push("journal_draft_state_unexpected");
    else ready.push("durable_tx_journal_sqlite_available");
    j.close();
    journalOk = true;
  } catch (e) {
    gaps.push(`journal_audit_failed:${e.message || e}`);
  }

  ready.push("mission2_approval_kind_separate_store");
  ready.push("mission2_rejects_eth_and_arb_bindings");

  let runner;
  try {
    runner = runnerAssert ? runnerAssert() : null;
  } catch (e) {
    gaps.push(`runner_assert_failed:${e.message || e}`);
    runner = { ok: false };
  }
  if (runner?.ok) {
    ready.push("mission2_step_runner_complete");
    ready.push("mission2_executor_independent_of_j8b");
    ready.push("mission2_rejects_eth_operator");
  } else if (runner && runner.ok === false) {
    gaps.push(`mission2_runner_incomplete:missing=${(runner.missing || []).join(",")}`);
  } else {
    gaps.push("mission2_runner_not_asserted");
  }

  const hardGaps = gaps.filter(Boolean);
  return {
    ok: hardGaps.length === 0 && journalOk && runner?.ok === true,
    production_ready_components: ready,
    engineering_gaps: hardGaps,
    runner,
    settlement: {
      source: "evm_erc20_transfer@eip155:8453",
      destination: "near_nep141_ft_delta",
      journal: journalOk ? "durable_sqlite" : "unavailable",
    },
    hard_stop: true,
  };
}

export async function auditMission2ProductionPathWithRunner(opts = {}) {
  const { assertMission2RunnerComplete } = await import("./mission2Executor.mjs");
  return auditMission2ProductionPath({
    ...opts,
    runnerAssert: assertMission2RunnerComplete,
  });
}