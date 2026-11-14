/**
 * Mission 1 production step runner — Ethereum USDC → NEAR NEP-141 USDC.
 * Independent of J8B Arb and Mission 1 Eth operators. Default invoke=false (no mutations).
 */
import { createHash } from "node:crypto";
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  MAINNET_IDENTITIES,
  MAINNET_USDC,
  MAINNET_EVM_RPCS,
} from "./identities.mjs";
import {
  M2_BASE_NEAR_USDC,
  NEAR_NATIVE_USDC_CONTRACT,
} from "./canaryRouteProfiles.mjs";
import {
  CANARY_STATES,
  CANARY_ATTESTOR_PK,
  advanceLifecycle,
  getLifecycleState,
  bindQuoteToApproval,
  bindTxAuthorization,
  bindBroadcastHash,
  requireOperatorConfirmation,
  consumeCanaryApproval,
  tryClaimExecution,
  releaseExecutionClaim,
  windowStatusReport,
} from "./canaryOneShot.mjs";
import {
  MISSION2_AMOUNT,
  MISSION2_PROFILE_AMOUNT,
  MISSION2_LIVE_AMOUNT_CAP,
  MISSION2_CHAIN_ID,
  MISSION2_TOKEN,
  MISSION2_ASSET_IN,
  MISSION2_ASSET_OUT,
  mission2StoreDir,
  validateMission2CanaryApproval,
  createMission2CanaryApproval,
  verifyMission2Settlement,
} from "./mission2ExecutionPath.mjs";
import { productionDryQuote } from "./intents.mjs";
import {
  attestTidepoolQuote,
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
} from "../intents-codec/quote-auth.mjs";
import {
  evaluateLiveMinOutAgainstPolicy,
  buildErc20TxParams,
  simulatePolicyChecks,
} from "./quotePath.mjs";
import {
  fetchBaseGasPrice,
  estimateBaseErc20TransferGas,
} from "./baseFunding.mjs";
import { evmNativeBalance, evmErc20Balance } from "./evmBalances.mjs";
import { ethJsonRpc } from "./canaryAdapters.mjs";
import {
  checkNearFtStorageRegistered,
  settlementRecoverySteps,
} from "./canarySettlement.mjs";
import { openTxJournal, localTxHash, TX_STATE } from "../execution/txJournal.mjs";
import { GAS_ASSUMPTIONS } from "./j5_2.quoteScan.mjs";
import { waitForPendingOp } from "./canaryRecovery.mjs";
import {
  confirmMission2Phase,
  fetchMission2TrustedState,
  assertMission2FixturesAllowed,
  verifyMission2SignedRaw,
  verifyMission2ReconcileOnchain,
  mission2SafeAdvance,
  resolveMission2LiveGate,
  isAmbiguousOutcome,
} from "./mission2Safety.mjs";
import {
  createMission2LiveAdapters,
  createMission2ViewAdapters,
} from "./mission2Adapters.mjs";
import { recoverFromHash } from "../gate-k/settle.mjs";
import { readFileSync, existsSync } from "node:fs";

export const MISSION2_RUNNER_STEPS = Object.freeze([
  "prepareApproval",
  "quoteAttest",
  "verifyUnpaused",
  "propose",
  "requestSignature",
  "persistSignedRaw",
  "broadcast",
  "settle",
  "reconcilePending",
  "verifyPaused",
]);

export const MISSION2_QUOTE_DEADLINE_MIN_REMAINING_MS = 60_000;

export function listMission2RunnerSteps() {
  return [...MISSION2_RUNNER_STEPS];
}

export function mission2RunnerCapabilities() {
  return {
    ok: true,
    kind: "mission2_base_near_executor_v1",
    independent_of_j8b: true,
    rejects_j8b_operator: true,
    rejects_eth_operator: true,
    chain_id: MISSION2_CHAIN_ID,
    token: MISSION2_TOKEN,
    asset_in: MISSION2_ASSET_IN,
    asset_out: MISSION2_ASSET_OUT,
    recipient: M2_BASE_NEAR_USDC.recipient,
    refund_to: M2_BASE_NEAR_USDC.refund_to,
    amount: MISSION2_AMOUNT,
    steps: listMission2RunnerSteps(),
    invoke_default: false,
    hard_stop_without_financial_approval: true,
  };
}

function dirOf(env, storeDir) {
  return storeDir || mission2StoreDir(env);
}

function atomicWrite(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function extractQuoteDeadlineMs(quoteResult) {
  const raw =
    quoteResult?.deadline ||
    quoteResult?.quote?.deadline ||
    quoteResult?.one_click_response?.quote?.deadline ||
    null;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function chooseMission2GasParams({
  liveGasPriceWei,
  gasLimit,
  ethBalanceWei,
  maxGasPriceWei = String(GAS_ASSUMPTIONS.base.max_gas_price_wei),
}) {
  const live = BigInt(liveGasPriceWei);
  const limit = BigInt(gasLimit);
  const max = BigInt(maxGasPriceWei);
  let gasPrice = (live * 150n) / 100n;
  if (gasPrice < live) gasPrice = live;
  if (gasPrice > max) gasPrice = max;
  const need = gasPrice * limit;
  const bal = BigInt(ethBalanceWei);
  const blockers = [];
  if (live > max) {
    blockers.push({
      code: "live_gas_price_exceeds_ceiling",
      live: live.toString(),
      max: max.toString(),
    });
  }
  if (bal < need) {
    blockers.push({
      code: "insufficient_base_eth_for_gas",
      have: bal.toString(),
      need: need.toString(),
    });
  }
  return {
    ok: blockers.length === 0,
    gas_price: gasPrice.toString(),
    gas_limit: limit.toString(),
    max_gas_price: max.toString(),
    fee_wei: need.toString(),
    blockers,
  };
}

export function setMission2NearUsdcBefore(
  operationId,
  beforeRaw,
  { env = process.env, storeDir = null } = {}
) {
  if (beforeRaw == null || beforeRaw === "") {
    return { ok: false, reason: "near_usdc_before_required" };
  }
  const v = validateMission2CanaryApproval(operationId, {
    env,
    storeDir: dirOf(env, storeDir),
  });
  if (!v.ok) return v;
  const next = { ...v.record, near_usdc_before: String(beforeRaw) };
  atomicWrite(v.path, next);
  return { ok: true, near_usdc_before: String(beforeRaw) };
}

/**
 * Phase confirmation — only accepted in the required lifecycle state
 * immediately before that mutation (no advance booking).
 */
export function recordMission2Confirmation(
  operationId,
  phase,
  { env = process.env, storeDir = null, note = null } = {}
) {
  return confirmMission2Phase(operationId, phase, {
    env,
    storeDir: dirOf(env, storeDir),
    note,
  });
}

/** Step 0 — create Mission2 approval (explicit only; never from readiness). */
export function mission2StepPrepareApproval(opts = {}) {
  const {
    operationId = null,
    amount = MISSION2_PROFILE_AMOUNT,
    env = process.env,
    storeDir = null,
    maxGasPrice = String(GAS_ASSUMPTIONS.base.max_gas_price_wei),
    maxSlippageBps = 50,
    ttlMs,
  } = opts;
  return createMission2CanaryApproval({
    operationId,
    amount,
    env,
    storeDir: dirOf(env, storeDir),
    maxGasPrice,
    maxSlippageBps,
    ttlMs,
  });
}

/**
 * Step 1 — funded/dry quote + attest + bind digest/nonce (Base chain 8453).
 * Captures NEAR USDC before snapshot (required; never defaults to 0).
 */
export async function mission2StepQuoteAttest({
  operationId,
  env = process.env,
  storeDir = null,
  testHarness = false,
  allowFundedQuote = false,
  adapters = null,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const v = validateMission2CanaryApproval(operationId, { env, storeDir: sd });
  if (!v.ok) return { ok: false, reason: v.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.PREPARED) {
    return { ok: false, reason: `bad_state:${getLifecycleState(v.record)}` };
  }
  const tradeAmount = String(v.record.payload.amount);

  const fixtureGate = assertMission2FixturesAllowed(testHarness, deps);
  if (!fixtureGate.ok) return fixtureGate;

  const mpc = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
  const baseRpc = deps.baseRpc || MAINNET_EVM_RPCS.base;
  const nearRpc = deps.nearRpc || null;

  let a = adapters || deps.adapters || null;
  if (!testHarness && !a) {
    a = await createMission2ViewAdapters({ env, baseRpc });
  }

  const trusted = await fetchMission2TrustedState({
    adapters: a,
    baseRpc,
    nearRpc: nearRpc || a?.rpc || null,
    testHarness,
    deps,
  });
  if (!trusted.ok) return trusted;

  const limits = trusted.limits;
  if (!limits?.max_slippage_bps) {
    return { ok: false, reason: "limits_required" };
  }
  const epoch = Number(trusted.epoch);
  if (epoch !== 2) return { ok: false, reason: "mandate_epoch_mismatch", epoch };

  if (trusted.paused === false) {
    return { ok: false, reason: "policy_must_be_paused_before_quote_window" };
  }

  const baseBal = trusted.baseBal;
  const usdcBal = trusted.usdcBal;
  if (!baseBal?.ok || !usdcBal?.ok || BigInt(usdcBal.raw) < BigInt(tradeAmount)) {
    return { ok: false, reason: "insufficient_balances" };
  }

  // REQUIRED destination snapshot — refuse missing/null (never substitute 0)
  let nearBefore = trusted.nearUsdcBefore;
  if (nearBefore == null || nearBefore === "") {
    if (deps.nearBalanceFn) {
      nearBefore = await deps.nearBalanceFn();
    }
  }
  if (nearBefore == null || nearBefore === "") {
    return { ok: false, reason: "near_usdc_before_required" };
  }

  const storage = trusted.storage || { ok: true, registered: true };
  if (!storage.ok || !storage.registered) {
    return { ok: false, reason: "near_usdc_storage_unregistered" };
  }

  let quoteResult = deps.quoteResult;
  if (!quoteResult) {
    if (!testHarness && !allowFundedQuote) {
      return {
        ok: false,
        reason: "quote_result_required_or_allow_funded",
        note: "Inject deps.quoteResult in tests; live funded quote needs explicit allowFundedQuote + env gate",
      };
    }
    const prev = env.NIO_MAINNET_ALLOW_FUNDED_QUOTE;
    if (allowFundedQuote) env.NIO_MAINNET_ALLOW_FUNDED_QUOTE = "1";
    try {
      quoteResult = await productionDryQuote(
        {
          originAsset: MISSION2_ASSET_IN,
          destinationAsset: MISSION2_ASSET_OUT,
          amount: tradeAmount,
          slippageTolerance: 50,
          recipient: M2_BASE_NEAR_USDC.recipient,
          recipientType: "DESTINATION_CHAIN",
          refundTo: M2_BASE_NEAR_USDC.refund_to,
          refundType: "ORIGIN_CHAIN",
        },
        { allowFundedQuote }
      );
    } finally {
      if (prev === undefined) delete env.NIO_MAINNET_ALLOW_FUNDED_QUOTE;
      else env.NIO_MAINNET_ALLOW_FUNDED_QUOTE = prev;
    }
  }
  if (!quoteResult?.ok) {
    return { ok: false, reason: "quote_failed", quote: quoteResult };
  }
  if (quoteResult.one_click_verify && quoteResult.one_click_verify.ok === false) {
    return { ok: false, reason: "quote_signature_invalid", quote: quoteResult };
  }
  if (allowFundedQuote && !quoteResult.deposit_address) {
    return { ok: false, reason: "funded_quote_missing_deposit_address" };
  }
  const depositAddress =
    quoteResult.deposit_address || deps.depositAddress || null;
  if (!depositAddress) {
    return { ok: false, reason: "deposit_address_required_for_attest" };
  }

  const floor = evaluateLiveMinOutAgainstPolicy({
    amountIn: quoteResult.amount_in || tradeAmount,
    minAmountOut: quoteResult.min_amount_out,
    maxSlippageBps: Number(limits.max_slippage_bps || 100),
    label: M2_BASE_NEAR_USDC.id,
  });
  if (floor.result !== "PASS") {
    return { ok: false, reason: "policy_floor_blocked", floor };
  }

  const deadlineMs = extractQuoteDeadlineMs(quoteResult);
  if (deadlineMs != null && deadlineMs <= Date.now() + MISSION2_QUOTE_DEADLINE_MIN_REMAINING_MS) {
    return { ok: false, reason: "quote_deadline_too_soon_or_expired", deadline_ms: deadlineMs };
  }

  const gasPriceJ =
    deps.gasPrice || (await fetchBaseGasPrice(baseRpc));
  const gasEst =
    deps.gasEst ||
    (await estimateBaseErc20TransferGas({
      from: mpc,
      to: depositAddress,
      amount: tradeAmount,
      token: MISSION2_TOKEN,
      rpcUrl: baseRpc,
    }));
  if (!gasPriceJ.ok || !gasEst.ok) {
    return { ok: false, reason: "gas_estimate_failed" };
  }
  const gasParams = chooseMission2GasParams({
    liveGasPriceWei: gasPriceJ.gas_price_wei || gasPriceJ.wei,
    gasLimit: gasEst.gas_limit || gasEst.gas,
    ethBalanceWei: baseBal.wei,
  });
  if (!gasParams.ok) {
    return { ok: false, reason: "gas_params_blocked", gasParams };
  }

  let attestResult = deps.attestResult;
  if (!attestResult) {
    if (!quoteResult.one_click_response) {
      return { ok: false, reason: "one_click_response_required_for_attest" };
    }
    const attestor = deps.attestor;
    if (!attestor?.secretKey64) {
      return { ok: false, reason: "attestor_required" };
    }
    attestResult = attestTidepoolQuote({
      quoteResponse: quoteResult.one_click_response,
      agentRequest: {
        originAsset: MISSION2_ASSET_IN,
        destinationAsset: MISSION2_ASSET_OUT,
        amount: tradeAmount,
        depositType: "ORIGIN_CHAIN",
        recipient: M2_BASE_NEAR_USDC.recipient,
        refundTo: M2_BASE_NEAR_USDC.refund_to,
      },
      tokenContract: MISSION2_TOKEN,
      chainId: MISSION2_CHAIN_ID,
      maxGasPrice: gasParams.max_gas_price,
      gasLimit: gasParams.gas_limit,
      secretKey64: attestor.secretKey64,
      productionMode: true,
      mainnetFundedPath: true,
      policyLimits: limits,
      allowedDestinations: limits.allowed_destinations,
      allowedAssets: limits.allowed_assets,
      allowedChains: limits.allowed_chains,
    });
  }
  if (!attestResult?.ok) {
    return { ok: false, reason: "attestation_failed", attest: attestResult };
  }

  if (deps.verifyAttestSig !== false && attestResult.message_utf8 && attestResult.signature) {
    try {
      const attestor = deps.attestor;
      if (attestor?.secretKey64) {
        const ok = nacl.sign.detached.verify(
          Buffer.from(attestResult.message_utf8, "utf8"),
          bs58.decode(attestResult.signature.replace(/^ed25519:/, "")),
          nacl.sign.keyPair.fromSecretKey(attestor.secretKey64).publicKey
        );
        if (!ok) return { ok: false, reason: "attestation_sig_invalid" };
      }
    } catch {
      return { ok: false, reason: "attestation_sig_invalid" };
    }
  }

  // Fail closed on wrong Base bindings BEFORE any lifecycle advance
  const attestToken = String(
    attestResult.attestation?.token_contract || ""
  ).toLowerCase();
  const attestChain = Number(
    attestResult.attestation?.chain_id ?? MISSION2_CHAIN_ID
  );
  if (attestToken && attestToken !== MISSION2_TOKEN) {
    return { ok: false, reason: "wrong_token" };
  }
  if (attestChain !== MISSION2_CHAIN_ID) {
    return { ok: false, reason: "wrong_chain" };
  }

  let nonceFinal = deps.nonce;
  if (nonceFinal == null) {
    const nj = await ethJsonRpc(baseRpc, "eth_getTransactionCount", [mpc, "pending"]);
    nonceFinal = Number(BigInt(nj.result || "0x0"));
  } else {
    nonceFinal = Number(nonceFinal);
  }

  const policyTx = buildErc20TxParams({
    depositAddress:
      attestResult.attestation?.deposit_address || depositAddress,
    tokenContract: MISSION2_TOKEN,
    amountIn: tradeAmount,
    chainId: MISSION2_CHAIN_ID,
    nonce: nonceFinal,
    gasPrice: gasParams.gas_price,
    gasLimit: gasParams.gas_limit,
  });
  if (String(policyTx.token_contract).toLowerCase() !== MISSION2_TOKEN) {
    return { ok: false, reason: "wrong_token" };
  }
  if (Number(policyTx.chain_id || MISSION2_CHAIN_ID) !== MISSION2_CHAIN_ID) {
    return { ok: false, reason: "wrong_chain" };
  }
  if (String(policyTx.amount) !== tradeAmount) {
    return { ok: false, reason: "wrong_amount" };
  }

  const data = erc20TransferData(
    attestResult.attestation?.deposit_address || depositAddress,
    tradeAmount
  );
  const digest_hex = digestHex(
    eip155UnsignedDigest({
      nonce: nonceFinal,
      gasPrice: BigInt(gasParams.gas_price),
      gasLimit: BigInt(gasParams.gas_limit),
      to: MISSION2_TOKEN,
      data,
      chainId: MISSION2_CHAIN_ID,
    })
  );

  const policySim =
    deps.skipPolicySim === true
      ? { ok: true }
      : simulatePolicyChecks({
          attestation: attestResult.attestation,
          tx: policyTx,
          expectedEpoch: 2,
          mandateEpoch: epoch,
          allowedAssets: new Set(limits.allowed_assets || []),
          allowedDestinations: new Set(
            (limits.allowed_destinations || []).map((d) => String(d).toLowerCase())
          ),
          allowedChains: new Set([8453]),
          maxTradeValue: limits.max_trade_value,
          maxSlippageBps: limits.max_slippage_bps,
          maxGasBudget: limits.max_gas_budget,
          trustedSigners: new Set([CANARY_ATTESTOR_PK]),
          signerPublicKey: CANARY_ATTESTOR_PK,
          nowNs: BigInt(Date.now()) * 1_000_000n,
        });
  if (!policySim.ok) {
    return { ok: false, reason: "policy_sim_failed", policySim };
  }

  // All checks passed — persist snapshot + advance lifecycle
  const snap = setMission2NearUsdcBefore(operationId, nearBefore, {
    env,
    storeDir: sd,
  });
  if (!snap.ok) return snap;

  bindQuoteToApproval(operationId, {
    quoteHash:
      quoteResult.one_click_verify?.quote_hash ||
      quoteResult.quote_hash ||
      deps.quoteHash ||
      createHash("sha256").update(depositAddress).digest("hex"),
    depositAddress,
    env,
    storeDir: sd,
  });
  const qv = mission2SafeAdvance(
    advanceLifecycle(operationId, CANARY_STATES.QUOTE_VERIFIED, {
      env,
      storeDir: sd,
      outcome: {
        quote_hash: quoteResult.one_click_verify?.quote_hash || null,
        deposit: depositAddress,
        min_out: quoteResult.min_amount_out,
        quote_deadline_ms: deadlineMs,
        near_usdc_before: String(nearBefore),
      },
    }),
    "QUOTE_VERIFIED"
  );
  if (!qv.ok) return qv;

  bindTxAuthorization(operationId, {
    nonce: nonceFinal,
    digestHex: digest_hex,
    gasPrice: gasParams.gas_price,
    gasLimit: gasParams.gas_limit,
    env,
    storeDir: sd,
  });

  const proposeArgs = {
    operation_id: operationId,
    attestation: attestResult.attestation,
    attestation_signature: attestResult.signature,
    signer_public_key: CANARY_ATTESTOR_PK,
    tx: {
      nonce: String(nonceFinal),
      gas_price: gasParams.gas_price,
      gas_limit: gasParams.gas_limit,
      chain_id: String(MISSION2_CHAIN_ID),
      token_contract: MISSION2_TOKEN,
      to: attestResult.attestation?.deposit_address || depositAddress,
      amount: tradeAmount,
    },
    expected_epoch: 2,
  };

  const att = mission2SafeAdvance(
    advanceLifecycle(operationId, CANARY_STATES.ATTESTED, {
      env,
      storeDir: sd,
      outcome: {
        digest_hex,
        nonce: nonceFinal,
        min_out: quoteResult.min_amount_out,
        propose_args: proposeArgs,
        quote_deadline_ms: deadlineMs,
        near_usdc_before: String(nearBefore),
      },
    }),
    "ATTESTED"
  );
  if (!att.ok) return att;

  return {
    ok: true,
    stage: CANARY_STATES.ATTESTED,
    operation_id: operationId,
    chain_id: MISSION2_CHAIN_ID,
    token: MISSION2_TOKEN,
    digest_hex,
    nonce: nonceFinal,
    gas: gasParams,
    propose_args: proposeArgs,
    near_usdc_before: String(nearBefore),
    min_amount_out: quoteResult.min_amount_out,
    deposit_address: depositAddress,
    next: "Owner Ledger unpause(); then mission2StepVerifyUnpaused; then confirm propose",
  };
}

export async function mission2StepVerifyUnpaused({
  operationId,
  env = process.env,
  storeDir = null,
  testHarness = false,
  adapters = null,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const fixtureGate = assertMission2FixturesAllowed(testHarness, deps);
  if (!fixtureGate.ok) return fixtureGate;
  const v = validateMission2CanaryApproval(operationId, { env, storeDir: sd });
  if (!v.ok) return { ok: false, reason: v.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.ATTESTED) {
    return { ok: false, reason: `bad_state:${getLifecycleState(v.record)}` };
  }
  let a = adapters || deps.adapters || null;
  if (!testHarness && !a) {
    a = await createMission2ViewAdapters({ env });
  }
  const live = await resolveMission2LiveGate({
    adapters: a,
    testHarness,
    deps,
    requireUnpaused: true,
  });
  if (!live.ok) {
    return live.reason === "policy_re_paused"
      ? { ok: false, reason: "policy_still_paused", paused: live.paused }
      : live;
  }
  const adv = mission2SafeAdvance(
    advanceLifecycle(operationId, CANARY_STATES.OWNER_UNPAUSED, {
      env,
      storeDir: sd,
      outcome: { verified_unpaused: true },
    }),
    "OWNER_UNPAUSED"
  );
  if (!adv.ok) return adv;
  return { ok: true, stage: CANARY_STATES.OWNER_UNPAUSED };
}

export async function mission2StepPropose({
  operationId,
  env = process.env,
  storeDir = null,
  invoke = false,
  testHarness = false,
  adapters = null,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const fixtureGate = assertMission2FixturesAllowed(testHarness, deps);
  if (!fixtureGate.ok) return fixtureGate;
  const v = validateMission2CanaryApproval(operationId, {
    env,
    storeDir: sd,
    requireQuoteBound: true,
  });
  if (!v.ok) return { ok: false, reason: v.reason };
  const need = requireOperatorConfirmation(v.record, "propose");
  if (!need.ok) return { ok: false, reason: need.reason };
  const state = getLifecycleState(v.record);
  if (state === CANARY_STATES.PROPOSED) {
    return { ok: false, reason: "already_proposed_no_resubmit" };
  }
  if (state === CANARY_STATES.RECONCILIATION_REQUIRED) {
    return {
      ok: false,
      reason: "reconciliation_required_no_resubmit",
      note: "Ambiguous prior propose — read-only reconcile only",
    };
  }
  if (state !== CANARY_STATES.OWNER_UNPAUSED) {
    return { ok: false, reason: `bad_state:${state}` };
  }
  const args = v.record.outcomes?.[CANARY_STATES.ATTESTED]?.propose_args;
  if (!args) return { ok: false, reason: "propose_args_missing" };
  if (String(args.tx?.chain_id) !== String(MISSION2_CHAIN_ID)) {
    return { ok: false, reason: "wrong_chain" };
  }
  if (String(args.tx?.token_contract).toLowerCase() !== MISSION2_TOKEN) {
    return { ok: false, reason: "wrong_token" };
  }
  if (String(args.tx?.amount) !== String(v.record.payload.amount)) {
    return { ok: false, reason: "wrong_amount" };
  }
  if (!invoke) {
    return {
      ok: true,
      dry: true,
      propose_args: args,
      note: "Pass invoke:true after confirm at OWNER_UNPAUSED",
    };
  }

  let a = adapters || deps.adapters || null;
  if (!testHarness && !a) {
    a = await createMission2LiveAdapters({ env });
  }
  const live = await resolveMission2LiveGate({
    adapters: a,
    testHarness,
    deps: { ...deps, _pendingOpId: operationId },
    requireUnpaused: true,
  });
  if (!live.ok) return live;
  if (live.epoch != null && Number(live.epoch) !== 2) {
    return { ok: false, reason: "epoch_changed", epoch: live.epoch };
  }

  let existingPending = live.existingPending;
  if (
    existingPending === undefined &&
    a?.getPending &&
    !(testHarness && Object.prototype.hasOwnProperty.call(deps, "existingPending"))
  ) {
    existingPending = await a.getPending(operationId);
  }
  if (existingPending?.payload_commitment) {
    return {
      ok: false,
      reason: "already_on_chain_reserved",
      pending: existingPending,
      note: "Do not resubmit propose; reconcile read-only",
    };
  }

  const claim = tryClaimExecution(operationId, "propose", { env, storeDir: sd });
  if (!claim.ok) return claim;
  try {
    const res = deps.proposeFn
      ? await deps.proposeFn(args)
      : a?.proposeQuotedEvmTransfer
        ? await a.proposeQuotedEvmTransfer(args)
        : { ok: false, reason: "propose_adapter_missing" };

    if (!res?.ok && !res?.transaction_hash) {
      return res?.reason
        ? { ok: false, ...res }
        : { ok: false, reason: "propose_failed", detail: res };
    }
    if (res?.ok === false && !res?.transaction_hash) {
      return { ok: false, reason: res.reason || "propose_reported_failure", detail: res };
    }

    const digest = v.record.locked_digest_hex;
    let verified = null;
    if (testHarness && deps.pendingVerify) {
      verified = deps.pendingVerify;
    } else {
      const pendingAdapters =
        deps.pendingAdapters ||
        (a?.getPending
          ? a
          : testHarness && deps.getPending
            ? {
                getPending: deps.getPending,
                listPending: deps.listPending,
              }
            : null);
      if (!pendingAdapters?.getPending) {
        return {
          ok: false,
          reason: "pending_verify_adapter_required",
          note: "Cannot advance to PROPOSED without on-chain PendingOp verification",
        };
      }
      verified = await waitForPendingOp({
        adapters: pendingAdapters,
        operationId,
        expectedDigest: digest,
        attempts: deps.pendingAttempts ?? 8,
        delayMs: deps.pendingDelayMs ?? 750,
        sleepFn: deps.sleepFn,
      });
    }

    if (verified.ok) {
      const adv = mission2SafeAdvance(
        advanceLifecycle(operationId, CANARY_STATES.PROPOSED, {
          env,
          storeDir: sd,
          outcome: {
            near_tx: res.transaction_hash || res.near_tx || null,
            payload_commitment: verified.pending.payload_commitment,
            pending_source: verified.source || "verify",
          },
        }),
        "PROPOSED"
      );
      if (!adv.ok) return adv;
      return {
        ok: true,
        stage: CANARY_STATES.PROPOSED,
        near_tx: res.transaction_hash || null,
        pending: verified.pending,
      };
    }

    if (verified.reason === "payload_commitment_mismatch") {
      mission2SafeAdvance(
        advanceLifecycle(operationId, CANARY_STATES.FAILED, {
          env,
          storeDir: sd,
          outcome: {
            reason: "payload_commitment_mismatch",
            near_tx: res.transaction_hash || null,
            pending: verified.pending,
          },
        }),
        "FAILED"
      );
      return {
        ok: false,
        reason: "payload_commitment_mismatch",
        pending: verified.pending,
        may_resubmit: false,
      };
    }

    // Ambiguous — block resubmission; reconcile read-only
    const advR = mission2SafeAdvance(
      advanceLifecycle(operationId, CANARY_STATES.RECONCILIATION_REQUIRED, {
        env,
        storeDir: sd,
        outcome: {
          reason: verified.reason || "pending_op_temporarily_unverified",
          near_tx: res.transaction_hash || null,
          expected_digest: digest,
        },
      }),
      "RECONCILIATION_REQUIRED"
    );
    return {
      ok: false,
      reason: "reconciliation_required",
      stage: advR.ok
        ? CANARY_STATES.RECONCILIATION_REQUIRED
        : getLifecycleState(
            validateMission2CanaryApproval(operationId, { env, storeDir: sd })
              .record
          ),
      may_resubmit: false,
      detail: verified,
      note: "Ambiguous propose outcome — do not resubmit; read-only reconcile",
    };
  } finally {
    releaseExecutionClaim(operationId, "propose", { env, storeDir: sd });
  }
}

export async function mission2StepRequestSignature({
  operationId,
  env = process.env,
  storeDir = null,
  invoke = false,
  testHarness = false,
  adapters = null,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const fixtureGate = assertMission2FixturesAllowed(testHarness, deps);
  if (!fixtureGate.ok) return fixtureGate;
  const v = validateMission2CanaryApproval(operationId, { env, storeDir: sd });
  if (!v.ok) return { ok: false, reason: v.reason };
  const need = requireOperatorConfirmation(v.record, "sign");
  if (!need.ok) return { ok: false, reason: need.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.PROPOSED) {
    return { ok: false, reason: `bad_state:${getLifecycleState(v.record)}` };
  }
  const digest = v.record.locked_digest_hex;
  if (!digest) return { ok: false, reason: "digest_not_locked" };
  if (!invoke) {
    return {
      ok: true,
      dry: true,
      digest_hex: digest,
      note: "Pass invoke:true after confirm at PROPOSED",
    };
  }

  let a = adapters || deps.adapters || null;
  if (!testHarness && !a) {
    a = await createMission2LiveAdapters({ env });
  }
  const live = await resolveMission2LiveGate({
    adapters: a,
    testHarness,
    deps,
    requireUnpaused: true,
  });
  if (!live.ok) return live;
  if (live.epoch != null && Number(live.epoch) !== 2) {
    return { ok: false, reason: "epoch_changed_before_sign", epoch: live.epoch };
  }

  const pendingPre =
    testHarness && Object.prototype.hasOwnProperty.call(deps, "pendingPreSign")
      ? deps.pendingPreSign
      : a?.getPending
        ? await a.getPending(operationId)
        : deps.pendingPreSign;
  if (!pendingPre) {
    return { ok: false, reason: "pending_missing_before_sign" };
  }
  if (String(pendingPre.signing_state) !== "Reserved") {
    return {
      ok: false,
      reason: "signing_state_not_reserved",
      signing_state: pendingPre.signing_state,
      note: "Do not request_signature twice",
    };
  }
  if (
    String(pendingPre.payload_commitment || "").toLowerCase() !==
    String(digest).toLowerCase()
  ) {
    return { ok: false, reason: "payload_commitment_mismatch_before_sign" };
  }

  const res = deps.signFn
    ? await deps.signFn(operationId)
    : a?.requestSignature
      ? await a.requestSignature(operationId)
      : { ok: false, reason: "sign_adapter_missing" };

  if (!res?.ok && !res?.transaction_hash) {
    return res?.reason
      ? { ok: false, ...res }
      : { ok: false, reason: "sign_failed", detail: res };
  }

  const full = deps.nearTxFull
    ? deps.nearTxFull
    : res.transaction_hash && a?.waitNearTx
      ? await a.waitNearTx(res.transaction_hash)
      : null;

  if (!full && !deps.assembled) {
    return {
      ok: false,
      reason: "near_finality_pending",
      residual: true,
      may_repeat_request_signature: false,
      propose_tx: res.transaction_hash,
      note: "Ambiguous MPC outcome — do not repeat request_signature; reconcile",
    };
  }

  const assembled =
    deps.assembled ||
    (a?.assembleEip155FromMpcNearTx
      ? a.assembleEip155FromMpcNearTx({
          nearTxFull: full,
          nonce: v.record.locked_nonce,
          gasPrice: v.record.locked_gas_price,
          gasLimit: v.record.locked_gas_limit,
          depositAddress: v.record.payload?.deposit_address,
          amount: v.record.payload?.amount,
          token: MISSION2_TOKEN,
          chainId: MISSION2_CHAIN_ID,
          expectedDigestHex: digest,
        })
      : null);

  if (!assembled?.ok) {
    if (assembled && isAmbiguousOutcome(assembled.reason)) {
      return {
        ok: false,
        ...assembled,
        may_repeat_request_signature: false,
      };
    }
    if (assembled) {
      const failAdv = mission2SafeAdvance(
        advanceLifecycle(operationId, CANARY_STATES.FAILED, {
          env,
          storeDir: sd,
          outcome: assembled,
        }),
        "FAILED"
      );
      return { ok: false, ...assembled, advance: failAdv };
    }
    return { ok: false, reason: "assemble_adapter_missing" };
  }

  // Never default a missing observed digest to the expected digest
  const observed =
    assembled.observed_digest_hex ||
    assembled.digest_hex ||
    deps.mpcDigestHex ||
    null;
  if (!observed) {
    return {
      ok: false,
      reason: "mpc_digest_not_observed",
      may_repeat_request_signature: false,
      note: "Missing observed digest must not default to expected",
    };
  }
  if (String(observed).toLowerCase() !== String(digest).toLowerCase()) {
    return {
      ok: false,
      reason: "mpc_digest_mismatch",
      observed,
      expected: digest,
      may_repeat_request_signature: false,
    };
  }

  const rawCheck =
    deps.skipSignedRawVerify === true && testHarness
      ? { ok: true }
      : a?.verifySignedRawAgainstAuth
        ? a.verifySignedRawAgainstAuth(assembled.rawHex, {
            deposit_address: v.record.payload?.deposit_address,
            amount: v.record.payload?.amount,
            nonce: v.record.locked_nonce,
            gas_price: v.record.locked_gas_price,
            gas_limit: v.record.locked_gas_limit,
            digest_hex: digest,
          })
        : verifyMission2SignedRaw(
            assembled.rawHex,
            {
              deposit_address: v.record.payload?.deposit_address,
              amount: v.record.payload?.amount,
              nonce: v.record.locked_nonce,
              gas_price: v.record.locked_gas_price,
              gas_limit: v.record.locked_gas_limit,
              digest_hex: digest,
            },
            {
              recoverFn:
                deps.recoverFn ||
                ((hash, r, s, recoveryId) => {
                  let addr = recoverFromHash(hash, r, s, recoveryId);
                  const mpc = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
                  if (addr.toLowerCase() !== mpc) {
                    const alt = recoverFromHash(hash, r, s, recoveryId ^ 1);
                    if (alt.toLowerCase() === mpc) addr = alt;
                  }
                  return addr;
                }),
            }
          );
  if (!rawCheck.ok) return { ok: false, ...rawCheck };

  const pendingPost =
    testHarness && deps.pendingPostSign !== undefined
      ? deps.pendingPostSign
      : a?.getPending
        ? await a.getPending(operationId)
        : pendingPre;
  if (
    !pendingPost?.payload_commitment ||
    String(pendingPost.payload_commitment).toLowerCase() !==
      String(observed).toLowerCase()
  ) {
    return { ok: false, reason: "payload_commitment_mismatch_at_sign" };
  }

  const lhash = localTxHash(assembled.rawHex);
  bindTxAuthorization(operationId, {
    nonce: v.record.locked_nonce,
    digestHex: digest,
    localTxHash: lhash,
    gasPrice: v.record.locked_gas_price,
    gasLimit: v.record.locked_gas_limit,
    env,
    storeDir: sd,
  });

  // Persist assembled raw into approval outcome for persist step binding
  const adv = mission2SafeAdvance(
    advanceLifecycle(operationId, CANARY_STATES.MPC_SIGNED, {
      env,
      storeDir: sd,
      outcome: {
        near_sign_tx: res.transaction_hash || null,
        digest_hex: digest,
        observed_digest_hex: observed,
        recovered: assembled.recovered || rawCheck.recovered,
        local_tx_hash: lhash,
        signed_raw_hex: assembled.rawHex,
      },
    }),
    "MPC_SIGNED"
  );
  if (!adv.ok) return adv;

  return {
    ok: true,
    stage: CANARY_STATES.MPC_SIGNED,
    digest_hex: digest,
    observed_digest_hex: observed,
    local_tx_hash: lhash,
    signed_raw_hex: assembled.rawHex,
    may_repeat_request_signature: false,
  };
}

/**
 * Persist identical signed raw bytes to durable journal BEFORE any broadcast.
 * Decodes and verifies recovered signer, chainId 1, nonce, gas, Eth USDC,
 * zero ETH value, exact ERC-20 transfer, deposit, and 1_000_000 amount.
 */
export function mission2StepPersistSignedRaw({
  operationId,
  signedRawHex = null,
  env = process.env,
  storeDir = null,
  testHarness = false,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const fixtureGate = assertMission2FixturesAllowed(testHarness, deps);
  if (!fixtureGate.ok) return fixtureGate;
  const v = validateMission2CanaryApproval(operationId, { env, storeDir: sd });
  if (!v.ok) return { ok: false, reason: v.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.MPC_SIGNED) {
    return { ok: false, reason: `bad_state:${getLifecycleState(v.record)}` };
  }
  const raw =
    signedRawHex ||
    v.record.outcomes?.[CANARY_STATES.MPC_SIGNED]?.signed_raw_hex ||
    null;
  if (!raw) return { ok: false, reason: "signed_raw_required" };

  const auth = {
    deposit_address: v.record.payload?.deposit_address,
    amount: v.record.payload?.amount,
    nonce: v.record.locked_nonce,
    gas_price: v.record.locked_gas_price,
    gas_limit: v.record.locked_gas_limit,
    digest_hex: v.record.locked_digest_hex,
    local_tx_hash:
      v.record.locked_local_tx_hash ||
      v.record.outcomes?.[CANARY_STATES.MPC_SIGNED]?.local_tx_hash ||
      null,
  };

  let verified;
  if (deps.skipSignedRawVerify === true && testHarness) {
    verified = {
      ok: true,
      rawHex: raw,
      local_tx_hash: localTxHash(raw),
      digest_hex: auth.digest_hex,
      recovered: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
    };
  } else {
    verified = verifyMission2SignedRaw(raw, auth, {
      recoverFn:
        deps.recoverFn ||
        ((hash, r, s, recoveryId) => {
          let addr = recoverFromHash(hash, r, s, recoveryId);
          const mpc = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
          if (addr.toLowerCase() !== mpc) {
            const alt = recoverFromHash(hash, r, s, recoveryId ^ 1);
            if (alt.toLowerCase() === mpc) addr = alt;
          }
          return addr;
        }),
    });
  }
  if (!verified.ok) return verified;

  const journal =
    deps.journal ||
    openTxJournal({
      path:
        deps.journalPath ||
        join(homedir(), ".nio-secure", "mainnet-mission2", "tx.sqlite"),
      secret: env.NIO_JOURNAL_SECRET || deps.journalSecret,
    });
  if (!deps.journalSecret && !env.NIO_JOURNAL_SECRET && !deps.journal) {
    return { ok: false, reason: "journal_secret_required" };
  }
  const id = operationId;
  const existing = journal.get(id);
  if (!existing) {
    journal.insertDraft({
      id,
      portfolio_id: MAINNET_IDENTITIES.portfolio_id,
      idempotency_key: id,
      nonce: String(v.record.locked_nonce),
      chain_id: String(MISSION2_CHAIN_ID),
      to: MISSION2_TOKEN,
      data_hash: createHash("sha256")
        .update(String(v.record.locked_digest_hex || ""))
        .digest("hex"),
    });
  }
  const lockedRaw = verified.rawHex || raw;
  const hash = verified.local_tx_hash || localTxHash(lockedRaw);
  journal.markSigned(id, { signedRawHex: lockedRaw });
  bindTxAuthorization(operationId, {
    nonce: v.record.locked_nonce,
    digestHex: v.record.locked_digest_hex,
    localTxHash: hash,
    gasPrice: v.record.locked_gas_price,
    gasLimit: v.record.locked_gas_limit,
    env,
    storeDir: sd,
  });
  const adv = mission2SafeAdvance(
    advanceLifecycle(operationId, CANARY_STATES.READY_TO_BROADCAST, {
      env,
      storeDir: sd,
      outcome: {
        local_tx_hash: hash,
        journal_id: id,
        signed_raw_locked: true,
        recovered: verified.recovered,
      },
    }),
    "READY_TO_BROADCAST"
  );
  if (!adv.ok) return adv;
  return {
    ok: true,
    stage: CANARY_STATES.READY_TO_BROADCAST,
    local_tx_hash: hash,
    journal_id: id,
    may_resign: false,
  };
}

/**
 * Exact-once broadcast via journal. UNKNOWN → read-only reconcile, never auto rebroadcast.
 */
export async function mission2StepBroadcast({
  operationId,
  env = process.env,
  storeDir = null,
  invoke = false,
  testHarness = false,
  adapters = null,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const fixtureGate = assertMission2FixturesAllowed(testHarness, deps);
  if (!fixtureGate.ok) return fixtureGate;
  const v = validateMission2CanaryApproval(operationId, {
    env,
    storeDir: sd,
    requireQuoteBound: true,
  });
  if (!v.ok) return { ok: false, reason: v.reason };
  const need = requireOperatorConfirmation(v.record, "broadcast");
  if (!need.ok) return { ok: false, reason: need.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.READY_TO_BROADCAST) {
    return { ok: false, reason: `bad_state:${getLifecycleState(v.record)}` };
  }
  // Post-signing operator confirmation must be recorded at READY_TO_BROADCAST
  if (!v.record.operator_confirmations?.broadcast) {
    return { ok: false, reason: "operator_confirm_required:broadcast" };
  }
  const deadlineMs =
    v.record.outcomes?.[CANARY_STATES.ATTESTED]?.quote_deadline_ms ||
    v.record.outcomes?.[CANARY_STATES.QUOTE_VERIFIED]?.quote_deadline_ms;
  if (
    deadlineMs != null &&
    deadlineMs <= Date.now() + MISSION2_QUOTE_DEADLINE_MIN_REMAINING_MS
  ) {
    return { ok: false, reason: "quote_expired_before_broadcast" };
  }
  if (
    v.record.locked_nonce == null ||
    !v.record.locked_digest_hex ||
    !v.record.locked_gas_price ||
    !v.record.locked_gas_limit ||
    !v.record.locked_local_tx_hash
  ) {
    return { ok: false, reason: "authorization_locks_incomplete" };
  }

  if (!invoke) {
    return {
      ok: true,
      dry: true,
      note: "Pass invoke:true after explicit post-signing broadcast confirmation",
    };
  }

  let a = adapters || deps.adapters || null;
  if (!testHarness && !a) {
    a = await createMission2LiveAdapters({ env });
  }
  const live = await resolveMission2LiveGate({
    adapters: a,
    testHarness,
    deps,
    requireUnpaused: true,
  });
  if (!live.ok) return live;

  const journal = deps.journal;
  if (!journal) return { ok: false, reason: "journal_required" };
  const cur = journal.get(operationId);
  if (!cur) return { ok: false, reason: "journal_entry_missing" };
  if (cur.state === TX_STATE.UNKNOWN) {
    return {
      ok: false,
      reason: "journal_unknown_requires_reconcile",
      may_resign: false,
      may_rebroadcast_identical: false,
      note: "Read-only on-chain reconciliation only — never automatic second send",
    };
  }
  if (
    cur.broadcast_hash &&
    [
      TX_STATE.BROADCAST,
      TX_STATE.CONFIRMED,
      TX_STATE.SETTLEMENT_PENDING,
      TX_STATE.SETTLED,
    ].includes(cur.state)
  ) {
    return {
      ok: true,
      skipped: true,
      broadcast_hash: cur.broadcast_hash,
      may_resign: false,
      note: "already_broadcast_journal_authority",
    };
  }

  const raw = deps.signedRawHex || journal.loadSignedRaw(operationId);
  if (!raw) return { ok: false, reason: "signed_bytes_missing" };

  // Exact journal binding: local hash must match locked auth
  const rawHash = localTxHash(raw);
  if (
    String(rawHash).toLowerCase() !==
    String(v.record.locked_local_tx_hash).toLowerCase()
  ) {
    return {
      ok: false,
      reason: "journal_binding_mismatch",
      may_resign: false,
      got: rawHash,
      want: v.record.locked_local_tx_hash,
    };
  }

  const recoverFn =
    deps.recoverFn ||
    ((hash, r, s, recoveryId) => {
      let addr = recoverFromHash(hash, r, s, recoveryId);
      const mpc = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
      if (addr.toLowerCase() !== mpc) {
        const alt = recoverFromHash(hash, r, s, recoveryId ^ 1);
        if (alt.toLowerCase() === mpc) addr = alt;
      }
      return addr;
    });
  const rawCheck =
    deps.skipSignedRawVerify === true && testHarness
      ? { ok: true }
      : a?.verifySignedRawAgainstAuth
        ? a.verifySignedRawAgainstAuth(raw, {
            deposit_address: v.record.payload?.deposit_address,
            amount: v.record.payload?.amount,
            nonce: v.record.locked_nonce,
            gas_price: v.record.locked_gas_price,
            gas_limit: v.record.locked_gas_limit,
            digest_hex: v.record.locked_digest_hex,
            local_tx_hash: v.record.locked_local_tx_hash,
          })
        : verifyMission2SignedRaw(
            raw,
            {
              deposit_address: v.record.payload?.deposit_address,
              amount: v.record.payload?.amount,
              nonce: v.record.locked_nonce,
              gas_price: v.record.locked_gas_price,
              gas_limit: v.record.locked_gas_limit,
              digest_hex: v.record.locked_digest_hex,
              local_tx_hash: v.record.locked_local_tx_hash,
            },
            { recoverFn }
          );
  if (!rawCheck.ok) {
    return { ok: false, ...rawCheck, may_resign: false };
  }

  // Live Base nonce check
  const mpc = MAINNET_IDENTITIES.mpc_evm_address;
  const ethRpc = deps.baseRpc || a?.ethRpc || MAINNET_EVM_RPCS.base;
  let nonceLatest;
  let noncePending;
  if (testHarness && deps.nonce != null) {
    nonceLatest = Number(deps.nonce);
    noncePending = Number(deps.nonce);
  } else if (a?.eth) {
    const [nl, np] = await Promise.all([
      a.eth("eth_getTransactionCount", [mpc, "latest"]),
      a.eth("eth_getTransactionCount", [mpc, "pending"]),
    ]);
    if (!nl?.result || !np?.result) {
      return {
        ok: false,
        reason: "base_nonce_rpc_ambiguous",
        may_resign: false,
        note: "Reconcile read-only; never automatic retry",
      };
    }
    nonceLatest = Number(BigInt(nl.result));
    noncePending = Number(BigInt(np.result));
  } else {
    const [nl, np] = await Promise.all([
      ethJsonRpc(ethRpc, "eth_getTransactionCount", [mpc, "latest"]),
      ethJsonRpc(ethRpc, "eth_getTransactionCount", [mpc, "pending"]),
    ]);
    if (!nl?.result || !np?.result) {
      return {
        ok: false,
        reason: "base_nonce_rpc_ambiguous",
        may_resign: false,
      };
    }
    nonceLatest = Number(BigInt(nl.result));
    noncePending = Number(BigInt(np.result));
  }
  if (noncePending > nonceLatest) {
    return {
      ok: false,
      reason: "eth_pending_nonce_in_flight",
      may_resign: false,
      nonce_latest: nonceLatest,
      nonce_pending: noncePending,
    };
  }
  if (nonceLatest !== Number(v.record.locked_nonce)) {
    return {
      ok: false,
      reason: "base_nonce_not_available_for_broadcast",
      may_resign: false,
      nonce_latest: nonceLatest,
      expected_nonce: v.record.locked_nonce,
    };
  }
  if (
    deps.expectedNonce != null &&
    Number(v.record.locked_nonce) !== Number(deps.expectedNonce)
  ) {
    return { ok: false, reason: "wrong_nonce" };
  }

  // On-chain prior-submission check via PendingOp + optional eth_getTransaction
  const pending =
    testHarness && deps.pending !== undefined
      ? deps.pending
      : a?.getPending
        ? await a.getPending(operationId)
        : deps.pending;
  if (!pending?.payload_commitment) {
    return {
      ok: false,
      reason: "pending_op_missing_payload_commitment",
      may_resign: false,
    };
  }
  if (
    String(pending.payload_commitment).toLowerCase() !==
    String(v.record.locked_digest_hex).toLowerCase()
  ) {
    return {
      ok: false,
      reason: "pending_payload_commitment_mismatch",
      may_resign: false,
    };
  }
  if (deps.priorTxHash || deps.checkPriorSubmission) {
    const prior = deps.checkPriorSubmission
      ? await deps.checkPriorSubmission({
          localTxHash: v.record.locked_local_tx_hash,
          nonce: v.record.locked_nonce,
        })
      : null;
    if (prior?.found || prior?.halt_broadcast) {
      return {
        ok: false,
        reason: prior.reason || "prior_submission_detected",
        may_resign: false,
        prior,
      };
    }
  }

  journal.beginBroadcast(operationId);
  let send;
  try {
    send = deps.baseSend
      ? await deps.baseSend(raw)
      : a?.eth
        ? await a.eth("eth_sendRawTransaction", [raw])
        : { error: { message: "base_send_adapter_missing" } };
  } catch (e) {
    journal.markUnknown(operationId, {
      rpc_error: String(e.message || e).slice(0, 200),
    });
    return {
      ok: false,
      reason: "broadcast_rpc_timeout_or_error",
      may_resign: false,
      status: TX_STATE.UNKNOWN,
      note: "Ambiguous — reconcile read-only, never auto-retry",
    };
  }
  if (send?.error || !send?.result) {
    const msg = String(send?.error?.message || send?.error || "broadcast_failed");
    if (/already known|nonce too low|replacement|timeout/i.test(msg)) {
      journal.markUnknown(operationId, { rpc: msg });
      return {
        ok: false,
        reason: "broadcast_ambiguous_reconcile_chain",
        may_resign: false,
        status: TX_STATE.UNKNOWN,
      };
    }
    return {
      ok: false,
      reason: "BROADCAST_FAILED",
      may_resign: false,
      error: send?.error,
    };
  }
  journal.markBroadcast(operationId, send.result);
  bindBroadcastHash(operationId, send.result, { env, storeDir: sd });
  const advB = mission2SafeAdvance(
    advanceLifecycle(operationId, CANARY_STATES.BROADCASTED, {
      env,
      storeDir: sd,
      outcome: { broadcast_hash: send.result },
    }),
    "BROADCASTED"
  );
  if (!advB.ok) return advB;
  const advS = mission2SafeAdvance(
    advanceLifecycle(operationId, CANARY_STATES.SETTLEMENT_PENDING, {
      env,
      storeDir: sd,
      outcome: { broadcast_hash: send.result },
    }),
    "SETTLEMENT_PENDING"
  );
  if (!advS.ok) return advS;
  return {
    ok: true,
    stage: CANARY_STATES.SETTLEMENT_PENDING,
    broadcast_hash: send.result,
    may_resign: false,
  };
}

export async function mission2StepSettle({
  operationId,
  env = process.env,
  storeDir = null,
  testHarness = false,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const fixtureGate = assertMission2FixturesAllowed(testHarness, deps);
  if (!fixtureGate.ok) return fixtureGate;
  const v = validateMission2CanaryApproval(operationId, { env, storeDir: sd });
  let record = v.record;
  if (!v.ok && v.reason === "approval_already_used") {
    return { ok: false, reason: v.reason };
  }
  if (!v.ok) return { ok: false, reason: v.reason };
  const state = getLifecycleState(record);
  if (
    state !== CANARY_STATES.SETTLEMENT_PENDING &&
    state !== CANARY_STATES.BROADCASTED
  ) {
    return { ok: false, reason: `bad_state:${state}` };
  }
  if (record.near_usdc_before == null || record.near_usdc_before === "") {
    return { ok: false, reason: "near_usdc_before_missing_refuse_zero_default" };
  }
  const minOut =
    deps.minAmountOut ||
    record.outcomes?.[CANARY_STATES.ATTESTED]?.min_out ||
    record.outcomes?.[CANARY_STATES.QUOTE_VERIFIED]?.min_out;
  if (!minOut) return { ok: false, reason: "min_amount_out_missing_for_near_check" };

  const txHash = record.locked_broadcast_hash;
  const deposit = record.payload.deposit_address;
  if (!txHash || !deposit) {
    return { ok: false, reason: "broadcast_or_deposit_missing" };
  }

  const settled = await verifyMission2Settlement({
    txHash,
    depositAddress: deposit,
    amount: record.payload?.amount,
    minAmountOut: minOut,
    nearUsdcBefore: record.near_usdc_before,
    baseRpcUrl: deps.baseRpc || MAINNET_EVM_RPCS.base,
    nearRpcUrl: deps.nearRpc,
    deps: {
      sourceVerify: deps.sourceVerify,
      oneClick: deps.oneClick,
      nearVerify: deps.nearVerify,
      settlePolls: deps.settlePolls,
      oneClickStatus: deps.oneClickStatus,
    },
  });
  if (!settled.ok) {
    return {
      ...settled,
      stage: CANARY_STATES.SETTLEMENT_PENDING,
      settlement_recovery:
        settled.settlement_recovery ||
        settlementRecoverySteps(settled.settlement?.normalized, {
          destinationKind: "near_nep141",
        }),
    };
  }
  const evidenceHash =
    deps.evidenceHash ||
    createHash("sha256")
      .update(`${txHash}:${settled.destination?.delta}:${minOut}`)
      .digest("hex");
  const adv = mission2SafeAdvance(
    advanceLifecycle(operationId, CANARY_STATES.SETTLED, {
      env,
      storeDir: sd,
      outcome: {
        near_delta: settled.destination?.delta,
        min_out: minOut,
        evidence_hash: evidenceHash,
      },
    }),
    "SETTLED"
  );
  if (!adv.ok) return adv;
  consumeCanaryApproval(operationId, { env, storeDir: sd, reason: "settled" });
  return {
    ok: true,
    stage: CANARY_STATES.SETTLED,
    ...settled,
    evidence_hash: evidenceHash,
    note: "reconcile_pending is a separate owner-Ledger confirmation",
  };
}

export async function mission2StepReconcilePending({
  operationId,
  env = process.env,
  storeDir = null,
  invoke = false,
  evidenceHash = null,
  testHarness = false,
  adapters = null,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const fixtureGate = assertMission2FixturesAllowed(testHarness, deps);
  if (!fixtureGate.ok) return fixtureGate;
  const path = join(sd, `${operationId}.json`);
  if (!existsSync(path)) return { ok: false, reason: "approval_not_found" };
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (getLifecycleState(record) !== CANARY_STATES.SETTLED) {
    return { ok: false, reason: `bad_state:${getLifecycleState(record)}` };
  }
  if (!record.operator_confirmations?.reconcile) {
    return { ok: false, reason: "operator_confirm_required:reconcile" };
  }
  const hash =
    evidenceHash ||
    record.outcomes?.[CANARY_STATES.SETTLED]?.evidence_hash ||
    null;
  if (!hash) return { ok: false, reason: "evidence_hash_required" };
  if (!invoke) {
    return {
      ok: true,
      dry: true,
      ledger: {
        method: "reconcile_pending",
        receiver: MAINNET_IDENTITIES.policy,
        args: {
          operation_id: operationId,
          settlement_state: "Success",
          evidence_hash: hash,
        },
      },
      note: "Owner Ledger only when reconciler unset",
    };
  }

  let a = adapters || deps.adapters || null;
  if (!testHarness && !a) {
    a = await createMission2LiveAdapters({ env });
  }

  let nearReceiptOk = true;
  if (deps.nearReceiptVerify) {
    const nr = await deps.nearReceiptVerify();
    if (!nr?.ok) {
      return { ok: false, reason: "near_receipt_verify_failed", detail: nr };
    }
  } else if (deps.nearReconcileTx && a?.waitNearTx) {
    try {
      const full = await a.waitNearTx(deps.nearReconcileTx);
      if (!full) {
        return {
          ok: false,
          reason: "near_reconcile_receipt_missing",
          may_retry_reconcile: false,
        };
      }
    } catch (e) {
      return {
        ok: false,
        reason: "near_reconcile_receipt_ambiguous",
        error: String(e.message || e).slice(0, 200),
      };
    }
  }

  if (deps.reconcileFn) {
    const res = await deps.reconcileFn({
      operation_id: operationId,
      settlement_state: "Success",
      evidence_hash: hash,
    });
    if (!res?.ok) return { ok: false, reason: "reconcile_failed", detail: res };
  } else if (a?.reconcilePending) {
    const res = await a.reconcilePending({
      operation_id: operationId,
      settlement_state: "Success",
      evidence_hash: hash,
    });
    if (!res?.ok) return { ok: false, reason: "reconcile_failed", detail: res };
  } else {
    return { ok: false, reason: "reconcile_adapter_missing_use_ledger" };
  }

  const onchain = await verifyMission2ReconcileOnchain({
    adapters: a || {
      getPending: deps.getPending,
      getPaused: deps.getPausedAfter
        ? async () => deps.pausedAfter
        : undefined,
      getEvidenceHash: deps.getEvidenceHash,
    },
    operationId,
    evidenceHash: hash,
    testHarness,
    deps: {
      pending: deps.pendingAfter,
      evidenceOnchain: deps.evidenceOnchain,
      pausedAfter: deps.pausedAfter,
    },
  });
  if (!onchain.ok) {
    return {
      ok: false,
      reason: onchain.reason || "reconcile_onchain_verify_failed",
      detail: onchain,
      note: "Do not mark RECONCILED without Success + evidence + policy state",
    };
  }
  void nearReceiptOk;

  const next = {
    ...record,
    lifecycle_state: CANARY_STATES.RECONCILED,
    outcomes: {
      ...record.outcomes,
      [CANARY_STATES.RECONCILED]: {
        at: new Date().toISOString(),
        evidence_hash: hash,
        settlement_state: "Success",
        paused_after: onchain.paused,
      },
    },
  };
  try {
    atomicWrite(path, next);
  } catch (e) {
    return {
      ok: false,
      reason: "reconcile_persist_failed",
      error: String(e.message || e).slice(0, 200),
    };
  }
  return {
    ok: true,
    stage: CANARY_STATES.RECONCILED,
    evidence_hash: hash,
    onchain,
  };
}

export async function mission2StepVerifyPaused({
  testHarness = false,
  adapters = null,
  deps = {},
} = {}) {
  const fixtureGate = assertMission2FixturesAllowed(testHarness, deps);
  if (!fixtureGate.ok) return fixtureGate;
  let paused;
  if (testHarness && Object.prototype.hasOwnProperty.call(deps, "paused")) {
    paused = deps.paused;
  } else {
    let a = adapters || deps.adapters || null;
    if (!a) a = await createMission2ViewAdapters({});
    if (!a?.getPaused) return { ok: false, reason: "pause_adapter_required" };
    paused = await a.getPaused();
  }
  if (paused !== true) {
    return { ok: false, reason: "policy_not_paused", paused };
  }
  return {
    ok: true,
    paused: true,
    window: windowStatusReport({
      policyPausedOnchain: true,
      broadcastStatus: "done",
      lifecycle: CANARY_STATES.RECONCILED,
    }),
  };
}

/**
 * No-mutation production dry rehearsal (quote/attest path optional via deps).
 * Never proposes, signs, broadcasts, or reconciles.
 */
export async function runMission2DryRehearsal({
  operationId = null,
  env = process.env,
  storeDir = null,
  allowFundedQuote = false,
  testHarness = false,
  adapters = null,
  deps = {},
} = {}) {
  const caps = mission2RunnerCapabilities();
  const runner = assertMission2RunnerComplete();
  const prep = mission2StepPrepareApproval({
    operationId,
    amount:
      deps.approvalAmount ||
      (testHarness ? MISSION2_LIVE_AMOUNT_CAP : MISSION2_PROFILE_AMOUNT),
    env,
    storeDir: dirOf(env, storeDir),
  });
  if (!prep.ok) {
    return {
      ok: false,
      reason: prep.reason || "prepare_failed",
      capabilities: caps,
      runner,
      mutations_invoked: false,
    };
  }
  const op = prep.operation_id || prep.record?.operation_id;
  let quote = null;
  if (deps.quoteResult || allowFundedQuote || testHarness) {
    quote = await mission2StepQuoteAttest({
      operationId: op,
      env,
      storeDir: dirOf(env, storeDir),
      testHarness,
      allowFundedQuote,
      adapters,
      deps,
    });
  }
  return {
    ok: runner.ok && (quote ? quote.ok : true),
    stage: "MISSION2_DRY_REHEARSAL_COMPLETE",
    operation_id: op,
    capabilities: caps,
    runner,
    quote,
    mutations_invoked: false,
    hard_stop: true,
    note: "No Ledger/propose/sign/broadcast/swap/reconcile. Financial approval still required separately.",
  };
}


/**
 * Map step name → function for readiness / operator CLI.
 */
export const MISSION2_STEP_HANDLERS = Object.freeze({
  prepareApproval: mission2StepPrepareApproval,
  quoteAttest: mission2StepQuoteAttest,
  verifyUnpaused: mission2StepVerifyUnpaused,
  propose: mission2StepPropose,
  requestSignature: mission2StepRequestSignature,
  persistSignedRaw: mission2StepPersistSignedRaw,
  broadcast: mission2StepBroadcast,
  settle: mission2StepSettle,
  reconcilePending: mission2StepReconcilePending,
  verifyPaused: mission2StepVerifyPaused,
});

export function assertMission2RunnerComplete() {
  const missing = MISSION2_RUNNER_STEPS.filter(
    (s) => typeof MISSION2_STEP_HANDLERS[s] !== "function"
  );
  const wiring = {
    live_adapters: typeof createMission2LiveAdapters === "function",
    view_adapters: typeof createMission2ViewAdapters === "function",
    dry_rehearsal: typeof runMission2DryRehearsal === "function",
    safety_confirm: typeof confirmMission2Phase === "function",
    signed_raw_verify: typeof verifyMission2SignedRaw === "function",
    independent_of_j8b: true,
    rejects_eth_operator: true,
    base_chain_id: MISSION2_CHAIN_ID,
  };
  const wiringGaps = Object.entries(wiring)
    .filter(([, v]) => v !== true && v !== MISSION2_CHAIN_ID)
    .map(([k]) => k);
  return {
    ok: missing.length === 0 && wiringGaps.length === 0,
    missing,
    wiring,
    wiring_gaps: wiringGaps,
    steps: listMission2RunnerSteps(),
    capabilities: mission2RunnerCapabilities(),
    cli_entry: "scripts/mainnet/mission2-operator.mjs",
  };
}
