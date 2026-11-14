/**
 * Mission 1 (Eth USDC → NEAR NEP-141 USDC) production execution path.
 * Approvals / propose / sign / broadcast are NEVER auto-invoked here.
 * J8B Arb→Base one-shot constants must not be reused.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MAINNET_IDENTITIES, MAINNET_USDC, MAINNET_EVM_RPCS } from "./identities.mjs";
import {
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
  CANARY_AMOUNT,
  CANARY_ATTESTOR_PK,
  CANARY_STATES,
  signApprovalPayload,
  verifyApprovalMac,
  DEFAULT_APPROVAL_TTL_MS,
  DEFAULT_MAX_GAS_PRICE,
} from "./canaryOneShot.mjs";
import {
  verifySourceUsdcTransfer,
  verifyNearNep141Delta,
  monitorOneClickByDeposit,
  settlementRecoverySteps,
} from "./canarySettlement.mjs";
import { openTxJournal, TX_STATE } from "../execution/txJournal.mjs";

export const MISSION1_APPROVAL_KIND = "one_shot_mainnet_mission1_v1";
export const MISSION1_AMOUNT = M1_ETH_NEAR_USDC.amount;
export const MISSION1_CHAIN_ID = M1_ETH_NEAR_USDC.source_chain_id;
export const MISSION1_TOKEN = M1_ETH_NEAR_USDC.source_token;
export const MISSION1_ASSET_IN = M1_ETH_NEAR_USDC.asset_in;
export const MISSION1_ASSET_OUT = M1_ETH_NEAR_USDC.asset_out;

export function mission1StoreDir(env = process.env) {
  return (
    env.NIO_MISSION1_STORE_DIR ||
    join(homedir(), ".nio-secure", "mainnet-mission1")
  );
}

function approvalPath(operationId, dir) {
  return join(dir, `${operationId}.json`);
}

function atomicWrite(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Reject accidental J8B binding reuse on Mission 1 payloads. */
export function assertMission1Bindings(payload) {
  assertNotJ8bRoute({
    source_chain_id: payload.chain_id,
    asset_out: payload.asset_out,
  });
  assertRouteAssetIsolation(M1_ETH_NEAR_USDC, {
    token: payload.token,
    assetIn: payload.asset_in,
    assetOut: payload.asset_out,
    chainId: payload.chain_id,
  });
  if (Number(payload.chain_id) === CANARY_CHAIN_ID) {
    throw new Error("mission1_must_not_use_j8b_chain");
  }
  if (String(payload.token).toLowerCase() === CANARY_TOKEN) {
    throw new Error("mission1_must_not_use_j8b_token");
  }
  if (payload.asset_in === CANARY_ASSET_IN || payload.asset_out === CANARY_ASSET_OUT) {
    throw new Error("mission1_must_not_use_j8b_assets");
  }
  if (String(payload.amount) !== MISSION1_AMOUNT) {
    throw new Error("mission1_amount_must_be_1_usdc");
  }
  return true;
}

/**
 * Preview-only approval payload. Does not write to disk or start TTL.
 */
export function buildMission1ApprovalPreview({
  quoteHash = null,
  depositAddress = null,
  maxGasPrice = DEFAULT_MAX_GAS_PRICE,
  maxSlippageBps = 50,
  suggestedOperationId = null,
} = {}) {
  const operation_id =
    suggestedOperationId ||
    `m1-canary-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const payload = {
    operation_id,
    owner: MAINNET_IDENTITIES.owner,
    policy: MAINNET_IDENTITIES.policy,
    agent: MAINNET_IDENTITIES.agent,
    mandate_epoch: 2,
    chain_id: MISSION1_CHAIN_ID,
    token: MISSION1_TOKEN,
    asset_in: MISSION1_ASSET_IN,
    asset_out: MISSION1_ASSET_OUT,
    amount: MISSION1_AMOUNT,
    mpc: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
    recipient: M1_ETH_NEAR_USDC.recipient,
    refund_to: M1_ETH_NEAR_USDC.refund_to,
    attestor_public_key: CANARY_ATTESTOR_PK,
    max_gas_price: String(maxGasPrice),
    max_slippage_bps: Number(maxSlippageBps),
    quote_hash: quoteHash,
    deposit_address: depositAddress
      ? String(depositAddress).toLowerCase()
      : null,
    route_id: M1_ETH_NEAR_USDC.id,
    destination_kind: M1_ETH_NEAR_USDC.destination_kind,
    destination_contract: NEAR_NATIVE_USDC_CONTRACT,
    kind: MISSION1_APPROVAL_KIND,
    note: "PREVIEW ONLY — not persisted; not an authorization",
  };
  assertMission1Bindings(payload);
  return {
    ok: true,
    persisted: false,
    operation_id,
    payload,
    independent_from_j8b: true,
  };
}

/**
 * Persist a Mission 1 one-shot approval (explicit call only — never from preflight).
 */
export function createMission1CanaryApproval({
  operationId,
  quoteHash = null,
  depositAddress = null,
  maxGasPrice = DEFAULT_MAX_GAS_PRICE,
  maxSlippageBps = 50,
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
  env = process.env,
  storeDir = null,
} = {}) {
  const dir = storeDir || mission1StoreDir(env);
  mkdirSync(dir, { recursive: true });
  const preview = buildMission1ApprovalPreview({
    quoteHash,
    depositAddress,
    maxGasPrice,
    maxSlippageBps,
    suggestedOperationId: operationId,
  });
  const expires_at = new Date(Date.now() + ttlMs).toISOString();
  const payload = {
    ...preview.payload,
    expires_at,
    note: undefined,
  };
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

export function validateMission1CanaryApproval(
  operationId,
  { env = process.env, storeDir = null, nowMs = Date.now(), requireQuoteBound = false } = {}
) {
  const dir = storeDir || mission1StoreDir(env);
  const path = approvalPath(operationId, dir);
  if (!existsSync(path)) return { ok: false, reason: "approval_not_found" };
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (!verifyApprovalMac(record, env)) {
    return { ok: false, reason: "approval_mac_invalid" };
  }
  if (record.used) return { ok: false, reason: "approval_already_used" };
  const p = record.payload;
  if (p.kind !== MISSION1_APPROVAL_KIND) {
    return { ok: false, reason: "not_mission1_approval" };
  }
  if (Date.parse(p.expires_at) <= nowMs) {
    return { ok: false, reason: "approval_expired" };
  }
  try {
    assertMission1Bindings(p);
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
  const checks = [
    ["owner", p.owner, MAINNET_IDENTITIES.owner],
    ["policy", p.policy, MAINNET_IDENTITIES.policy],
    ["agent", p.agent, MAINNET_IDENTITIES.agent],
    ["mandate_epoch", Number(p.mandate_epoch), 2],
    ["chain_id", Number(p.chain_id), MISSION1_CHAIN_ID],
    ["token", String(p.token).toLowerCase(), MISSION1_TOKEN],
    ["amount", String(p.amount), MISSION1_AMOUNT],
    ["mpc", String(p.mpc).toLowerCase(), MAINNET_IDENTITIES.mpc_evm_address.toLowerCase()],
    ["asset_in", p.asset_in, MISSION1_ASSET_IN],
    ["asset_out", p.asset_out, MISSION1_ASSET_OUT],
    ["recipient", p.recipient, M1_ETH_NEAR_USDC.recipient],
    ["attestor", p.attestor_public_key, CANARY_ATTESTOR_PK],
  ];
  for (const [name, got, want] of checks) {
    if (got !== want) {
      return { ok: false, reason: `approval_mismatch_${name}`, got, want };
    }
  }
  if (requireQuoteBound && (!p.quote_hash || !p.deposit_address)) {
    return { ok: false, reason: "approval_quote_not_bound" };
  }
  return { ok: true, mode: "one_shot_mission1", operation_id: operationId, payload: p, record, path };
}

/**
 * Exact on-chain / off-chain transaction sequence for Mission 1 (preview).
 */
export function buildMission1TransactionPlan({
  quote = null,
  gasEconomics = null,
  nonce = null,
  nearUsdcBefore = null,
} = {}) {
  const mpc = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
  const deposit = quote?.deposit_address || "<funded_1click_deposit_address>";
  const minOut = quote?.min_amount_out || "<policy_floor_cleared_min_out>";
  return {
    mutations_invoked: false,
    independent_operation: true,
    never_reuse: ["j8b-canary-*", "J8B nonce/quote/auth"],
    steps: [
      {
        step: 1,
        actor: "owner_Ledger",
        chain: "near",
        action: "unpause()",
        receiver: MAINNET_IDENTITIES.policy,
        note: "Short execution window only; re-pause after broadcast or abort",
      },
      {
        step: 2,
        actor: "agent",
        chain: "near",
        action: "propose_quoted_evm_transfer",
        receiver: MAINNET_IDENTITIES.policy,
        args_shape: {
          operation_id: "<fresh_m1_operation_id>",
          chain_id: String(MISSION1_CHAIN_ID),
          token_contract: MISSION1_TOKEN,
          to: deposit,
          amount: MISSION1_AMOUNT,
          asset_in: MISSION1_ASSET_IN,
          asset_out: MISSION1_ASSET_OUT,
          destination: M1_ETH_NEAR_USDC.recipient,
          min_amount_out: minOut,
          expected_epoch: 2,
        },
      },
      {
        step: 3,
        actor: "agent",
        chain: "near",
        action: "request_signature",
        receiver: MAINNET_IDENTITIES.policy,
        note: "MPC signs EIP-155 digest for Ethereum ERC-20 transfer",
      },
      {
        step: 4,
        actor: "mpc_evm",
        chain: "ethereum",
        action: "eth_sendRawTransaction",
        from: mpc,
        to: MISSION1_TOKEN,
        value_wei: "0",
        calldata: "ERC20.transfer(depositAddress, 1000000)",
        nonce: nonce,
        estimated_fee_eth: gasEconomics?.fee_eth ?? null,
        estimated_fee_usd: gasEconomics?.fee_usd_approx ?? null,
        explorer: "https://etherscan.io/tx/<tx_hash>",
      },
      {
        step: 5,
        actor: "operator_ro",
        chain: "ethereum+1click+near",
        action: "settlement_verify",
        checks: [
          "verifySourceUsdcTransfer(tx, mpc→deposit, 1000000, chainId=1, token=Eth USDC)",
          "monitorOneClickByDeposit(depositAddress) → SUCCESS",
          `verifyNearNep141Delta(nishanthb.near, before=${nearUsdcBefore ?? "<snapshot>"}, minOut)`,
        ],
      },
      {
        step: 6,
        actor: "owner_Ledger",
        chain: "near",
        action: "reconcile_pending(Success, evidence_hash)",
        receiver: MAINNET_IDENTITIES.policy,
        note: "Separate confirmation; reconciler unset → owner only",
      },
      {
        step: 7,
        actor: "owner_Ledger",
        chain: "near",
        action: "pause()",
        receiver: MAINNET_IDENTITIES.policy,
      },
    ],
  };
}

/**
 * Destination settlement for Mission 1 — NEP-141 delta, not Base USDC.
 */
export async function verifyMission1Settlement({
  txHash,
  depositAddress,
  mpc = MAINNET_IDENTITIES.mpc_evm_address,
  recipient = M1_ETH_NEAR_USDC.recipient,
  amount = MISSION1_AMOUNT,
  minAmountOut,
  nearUsdcBefore,
  ethRpcUrl = MAINNET_EVM_RPCS.ethereum,
  nearRpcUrl,
  deps = {},
} = {}) {
  const source =
    deps.sourceVerify ||
    (await verifySourceUsdcTransfer({
      txHash,
      mpc,
      escrow: depositAddress,
      amount,
      rpcUrl: ethRpcUrl,
      token: MAINNET_USDC.ethereum,
      expectedChainId: 1,
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
    return {
      ok: false,
      reason: "near_usdc_before_missing_refuse_zero_default",
    };
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
    note: "SUCCESS only after Eth transfer + 1Click SUCCESS + NEAR NEP-141 delta",
  };
}

/**
 * Static + injectable audit of production readiness (no mainnet mutations).
 * NO-GO until Mission1 step runner is complete and independent of J8B Arb operator.
 */
export function auditMission1ProductionPath({
  journalFactory = openTxJournal,
  env = process.env,
  runnerAssert = null,
} = {}) {
  const gaps = [];
  const ready = [];

  ready.push("verifySourceUsdcTransfer_parameterized_for_ethereum");
  ready.push("verifyNearNep141Delta_production_nep141");
  ready.push("monitorOneClickByDeposit_by_deposit_address");
  ready.push("mission1_settlement_wrapper_wired");
  ready.push("near_usdc_before_snapshot_required");

  let journalOk = false;
  try {
    const dir = join(homedir(), ".nio-secure", "tmp-mission1-audit");
    mkdirSync(dir, { recursive: true });
    const j = journalFactory({
      path: join(dir, `audit-${Date.now()}.sqlite`),
      secret: env.NIO_JOURNAL_SECRET || "mission1-audit-secret-32bytes-min!!",
    });
    const id = `m1-audit-${randomBytes(3).toString("hex")}`;
    j.insertDraft({
      id,
      portfolio_id: "nio-mainnet-v1",
      idempotency_key: id,
      nonce: "0",
      chain_id: String(MISSION1_CHAIN_ID),
      to: MISSION1_TOKEN,
      data_hash: createHash("sha256").update("audit").digest("hex"),
    });
    const draft = j.get(id);
    if (draft?.state !== TX_STATE.DRAFT) {
      gaps.push("journal_draft_state_unexpected");
    } else {
      ready.push("durable_tx_journal_sqlite_available");
    }
    const dup = j.insertDraft({
      id: `${id}-b`,
      portfolio_id: "nio-mainnet-v1",
      idempotency_key: id,
      nonce: "1",
      chain_id: String(MISSION1_CHAIN_ID),
      to: MISSION1_TOKEN,
      data_hash: createHash("sha256").update("audit2").digest("hex"),
    });
    if (dup?.idempotent === true) ready.push("journal_duplicate_idempotency_blocked");
    else ready.push("journal_insert_api_present");
    j.close();
    journalOk = true;
  } catch (e) {
    gaps.push(`journal_audit_failed:${e.message || e}`);
  }

  if (CANARY_CHAIN_ID !== 42161) {
    gaps.push("unexpected_j8b_default_chain");
  } else {
    ready.push("j8b_defaults_isolated_from_mission1_module");
  }
  ready.push("mission1_approval_kind_separate_store");
  ready.push("mission1_transaction_plan_documented");

  // Require independently executable Eth→NEAR runner (not J8B canary-operator)
  let runner;
  try {
    if (runnerAssert) {
      runner = runnerAssert();
    } else {
      // Lazy import to avoid cycles at module load
      runner = null;
    }
  } catch (e) {
    gaps.push(`runner_assert_failed:${e.message || e}`);
    runner = { ok: false };
  }
  if (runner?.ok) {
    ready.push("mission1_step_runner_complete");
    ready.push("mission1_executor_independent_of_j8b_arb");
  } else if (runner && runner.ok === false) {
    gaps.push(
      `mission1_runner_incomplete:missing=${(runner.missing || []).join(",")}`
    );
  } else {
    gaps.push("mission1_runner_not_asserted");
  }

  const hardGaps = gaps.filter(Boolean);
  return {
    ok: hardGaps.length === 0 && journalOk && runner?.ok === true,
    production_ready_components: ready,
    engineering_gaps: hardGaps,
    runner,
    settlement: {
      source: "evm_erc20_transfer@eip155:1",
      destination: "near_nep141_ft_delta",
      journal: journalOk ? "durable_sqlite" : "unavailable",
      duplicate_broadcast: "journal_state_machine",
    },
    hard_stop: true,
  };
}

/** Convenience: audit with live runner assert (call from scripts/tests). */
export async function auditMission1ProductionPathWithRunner(opts = {}) {
  const { assertMission1RunnerComplete } = await import("./mission1Executor.mjs");
  return auditMission1ProductionPath({
    ...opts,
    runnerAssert: assertMission1RunnerComplete,
  });
}
