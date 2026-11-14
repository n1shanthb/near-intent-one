/**
 * Mission 1 production step runner — Ethereum USDC → NEAR NEP-141 USDC.
 * Independent of J8B Arb canary-operator. Default invoke=false (no mutations).
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
  M1_ETH_NEAR_USDC,
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
  MISSION1_AMOUNT,
  MISSION1_CHAIN_ID,
  MISSION1_TOKEN,
  MISSION1_ASSET_IN,
  MISSION1_ASSET_OUT,
  mission1StoreDir,
  validateMission1CanaryApproval,
  createMission1CanaryApproval,
  verifyMission1Settlement,
} from "./mission1ExecutionPath.mjs";
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
  fetchEthereumGasPrice,
  estimateEthereumErc20TransferGas,
} from "./ethereumFunding.mjs";
import { evmNativeBalance, evmErc20Balance } from "./evmBalances.mjs";
import { ethJsonRpc } from "./canaryAdapters.mjs";
import {
  checkNearFtStorageRegistered,
  settlementRecoverySteps,
} from "./canarySettlement.mjs";
import { openTxJournal, localTxHash, TX_STATE } from "../execution/txJournal.mjs";
import { GAS_ASSUMPTIONS } from "./j5_2.quoteScan.mjs";

export const MISSION1_RUNNER_STEPS = Object.freeze([
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

export const MISSION1_QUOTE_DEADLINE_MIN_REMAINING_MS = 60_000;

export function listMission1RunnerSteps() {
  return [...MISSION1_RUNNER_STEPS];
}

export function mission1RunnerCapabilities() {
  return {
    ok: true,
    kind: "mission1_eth_near_executor_v1",
    independent_of_j8b: true,
    rejects_j8b_operator: true,
    chain_id: MISSION1_CHAIN_ID,
    token: MISSION1_TOKEN,
    asset_in: MISSION1_ASSET_IN,
    asset_out: MISSION1_ASSET_OUT,
    recipient: M1_ETH_NEAR_USDC.recipient,
    refund_to: M1_ETH_NEAR_USDC.refund_to,
    amount: MISSION1_AMOUNT,
    steps: listMission1RunnerSteps(),
    invoke_default: false,
    hard_stop_without_financial_approval: true,
  };
}

function dirOf(env, storeDir) {
  return storeDir || mission1StoreDir(env);
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

export function chooseMission1GasParams({
  liveGasPriceWei,
  gasLimit,
  ethBalanceWei,
  maxGasPriceWei = GAS_ASSUMPTIONS.ethereum.max_gas_price_wei,
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
      code: "insufficient_eth_for_gas",
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

export function setMission1NearUsdcBefore(
  operationId,
  beforeRaw,
  { env = process.env, storeDir = null } = {}
) {
  if (beforeRaw == null || beforeRaw === "") {
    return { ok: false, reason: "near_usdc_before_required" };
  }
  const v = validateMission1CanaryApproval(operationId, {
    env,
    storeDir: dirOf(env, storeDir),
  });
  if (!v.ok) return v;
  const next = { ...v.record, near_usdc_before: String(beforeRaw) };
  atomicWrite(v.path, next);
  return { ok: true, near_usdc_before: String(beforeRaw) };
}

export function recordMission1Confirmation(
  operationId,
  phase,
  { env = process.env, storeDir = null, note = null } = {}
) {
  const v = validateMission1CanaryApproval(operationId, {
    env,
    storeDir: dirOf(env, storeDir),
  });
  if (!v.ok) return v;
  const next = {
    ...v.record,
    operator_confirmations: {
      ...v.record.operator_confirmations,
      [phase]: { at: new Date().toISOString(), note: note || null },
    },
  };
  atomicWrite(v.path, next);
  return { ok: true, phase, record: next };
}

/** Step 0 — create Mission1 approval (explicit only; never from readiness). */
export function mission1StepPrepareApproval(opts = {}) {
  const {
    operationId = null,
    env = process.env,
    storeDir = null,
    maxGasPrice = String(GAS_ASSUMPTIONS.ethereum.max_gas_price_wei),
    maxSlippageBps = 50,
    ttlMs,
  } = opts;
  return createMission1CanaryApproval({
    operationId,
    env,
    storeDir: dirOf(env, storeDir),
    maxGasPrice,
    maxSlippageBps,
    ttlMs,
  });
}

/**
 * Step 1 — funded/dry quote + attest + bind digest/nonce (Eth chain 1).
 * Captures NEAR USDC before snapshot (required; never defaults to 0).
 */
export async function mission1StepQuoteAttest({
  operationId,
  env = process.env,
  storeDir = null,
  testHarness = false,
  allowFundedQuote = false,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const v = validateMission1CanaryApproval(operationId, { env, storeDir: sd });
  if (!v.ok) return { ok: false, reason: v.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.PREPARED) {
    return { ok: false, reason: `bad_state:${getLifecycleState(v.record)}` };
  }

  const mpc = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
  const ethRpc = deps.ethRpc || MAINNET_EVM_RPCS.ethereum;
  const nearRpc = deps.nearRpc || null;

  const limits = deps.limits || null;
  if (!limits?.max_slippage_bps) {
    return { ok: false, reason: "limits_required" };
  }
  const epoch = deps.epoch != null ? Number(deps.epoch) : 2;
  if (epoch !== 2) return { ok: false, reason: "mandate_epoch_mismatch", epoch };

  if (deps.paused === false) {
    return { ok: false, reason: "policy_must_be_paused_before_quote_window" };
  }

  const ethBal =
    deps.ethBal || (await evmNativeBalance(ethRpc, mpc));
  const usdcBal =
    deps.usdcBal ||
    (await evmErc20Balance(ethRpc, MISSION1_TOKEN, mpc));
  if (!ethBal.ok || !usdcBal.ok || BigInt(usdcBal.raw) < BigInt(MISSION1_AMOUNT)) {
    return { ok: false, reason: "insufficient_balances" };
  }

  // REQUIRED destination snapshot — refuse missing/null (never substitute 0)
  let nearBefore;
  if (Object.prototype.hasOwnProperty.call(deps, "nearUsdcBefore")) {
    nearBefore = deps.nearUsdcBefore;
    if (nearBefore == null || nearBefore === "") {
      return { ok: false, reason: "near_usdc_before_required" };
    }
  } else {
    if (deps.nearBalanceFn) {
      nearBefore = await deps.nearBalanceFn();
    } else if (!nearRpc) {
      return { ok: false, reason: "near_usdc_before_snapshot_unavailable" };
    }
    if (nearBefore == null || nearBefore === "") {
      return { ok: false, reason: "near_usdc_before_required" };
    }
  }

  const storage =
    deps.storage ||
    (nearRpc
      ? await checkNearFtStorageRegistered({
          accountId: M1_ETH_NEAR_USDC.recipient,
          tokenContract: NEAR_NATIVE_USDC_CONTRACT,
          rpcUrl: nearRpc,
        })
      : { ok: true, registered: true });
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
          originAsset: MISSION1_ASSET_IN,
          destinationAsset: MISSION1_ASSET_OUT,
          amount: MISSION1_AMOUNT,
          slippageTolerance: 50,
          recipient: M1_ETH_NEAR_USDC.recipient,
          recipientType: "DESTINATION_CHAIN",
          refundTo: M1_ETH_NEAR_USDC.refund_to,
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
    amountIn: quoteResult.amount_in || MISSION1_AMOUNT,
    minAmountOut: quoteResult.min_amount_out,
    maxSlippageBps: Number(limits.max_slippage_bps || 100),
    label: M1_ETH_NEAR_USDC.id,
  });
  if (floor.result !== "PASS") {
    return { ok: false, reason: "policy_floor_blocked", floor };
  }

  const deadlineMs = extractQuoteDeadlineMs(quoteResult);
  if (deadlineMs != null && deadlineMs <= Date.now() + MISSION1_QUOTE_DEADLINE_MIN_REMAINING_MS) {
    return { ok: false, reason: "quote_deadline_too_soon_or_expired", deadline_ms: deadlineMs };
  }

  const gasPriceJ =
    deps.gasPrice || (await fetchEthereumGasPrice(ethRpc));
  const gasEst =
    deps.gasEst ||
    (await estimateEthereumErc20TransferGas({
      from: mpc,
      to: depositAddress,
      amount: MISSION1_AMOUNT,
      token: MISSION1_TOKEN,
      rpcUrl: ethRpc,
    }));
  if (!gasPriceJ.ok || !gasEst.ok) {
    return { ok: false, reason: "gas_estimate_failed" };
  }
  const gasParams = chooseMission1GasParams({
    liveGasPriceWei: gasPriceJ.gas_price_wei || gasPriceJ.wei,
    gasLimit: gasEst.gas_limit || gasEst.gas,
    ethBalanceWei: ethBal.wei,
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
        originAsset: MISSION1_ASSET_IN,
        destinationAsset: MISSION1_ASSET_OUT,
        amount: MISSION1_AMOUNT,
        depositType: "ORIGIN_CHAIN",
        recipient: M1_ETH_NEAR_USDC.recipient,
        refundTo: M1_ETH_NEAR_USDC.refund_to,
      },
      tokenContract: MISSION1_TOKEN,
      chainId: MISSION1_CHAIN_ID,
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

  // Fail closed on wrong Eth bindings BEFORE any lifecycle advance
  const attestToken = String(
    attestResult.attestation?.token_contract || ""
  ).toLowerCase();
  const attestChain = Number(
    attestResult.attestation?.chain_id ?? MISSION1_CHAIN_ID
  );
  if (attestToken && attestToken !== MISSION1_TOKEN) {
    return { ok: false, reason: "wrong_token" };
  }
  if (attestChain !== MISSION1_CHAIN_ID) {
    return { ok: false, reason: "wrong_chain" };
  }

  let nonceFinal = deps.nonce;
  if (nonceFinal == null) {
    const nj = await ethJsonRpc(ethRpc, "eth_getTransactionCount", [mpc, "pending"]);
    nonceFinal = Number(BigInt(nj.result || "0x0"));
  } else {
    nonceFinal = Number(nonceFinal);
  }

  const policyTx = buildErc20TxParams({
    depositAddress:
      attestResult.attestation?.deposit_address || depositAddress,
    tokenContract: MISSION1_TOKEN,
    amountIn: MISSION1_AMOUNT,
    chainId: MISSION1_CHAIN_ID,
    nonce: nonceFinal,
    gasPrice: gasParams.gas_price,
    gasLimit: gasParams.gas_limit,
  });
  if (String(policyTx.token_contract).toLowerCase() !== MISSION1_TOKEN) {
    return { ok: false, reason: "wrong_token" };
  }
  if (Number(policyTx.chain_id || MISSION1_CHAIN_ID) !== MISSION1_CHAIN_ID) {
    return { ok: false, reason: "wrong_chain" };
  }
  if (String(policyTx.amount) !== MISSION1_AMOUNT) {
    return { ok: false, reason: "wrong_amount" };
  }

  const data = erc20TransferData(
    attestResult.attestation?.deposit_address || depositAddress,
    MISSION1_AMOUNT
  );
  const digest_hex = digestHex(
    eip155UnsignedDigest({
      nonce: nonceFinal,
      gasPrice: BigInt(gasParams.gas_price),
      gasLimit: BigInt(gasParams.gas_limit),
      to: MISSION1_TOKEN,
      data,
      chainId: MISSION1_CHAIN_ID,
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
          allowedChains: new Set([1]),
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
  const snap = setMission1NearUsdcBefore(operationId, nearBefore, {
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
  });

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
      chain_id: String(MISSION1_CHAIN_ID),
      token_contract: MISSION1_TOKEN,
      to: attestResult.attestation?.deposit_address || depositAddress,
      amount: MISSION1_AMOUNT,
    },
    expected_epoch: 2,
  };

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
  });

  return {
    ok: true,
    stage: CANARY_STATES.ATTESTED,
    operation_id: operationId,
    chain_id: MISSION1_CHAIN_ID,
    token: MISSION1_TOKEN,
    digest_hex,
    nonce: nonceFinal,
    gas: gasParams,
    propose_args: proposeArgs,
    near_usdc_before: String(nearBefore),
    min_amount_out: quoteResult.min_amount_out,
    deposit_address: depositAddress,
    next: "Owner Ledger unpause(); then mission1StepVerifyUnpaused; then confirm propose",
  };
}

export async function mission1StepVerifyUnpaused({
  operationId,
  env = process.env,
  storeDir = null,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const v = validateMission1CanaryApproval(operationId, { env, storeDir: sd });
  if (!v.ok) return { ok: false, reason: v.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.ATTESTED) {
    return { ok: false, reason: `bad_state:${getLifecycleState(v.record)}` };
  }
  const paused = deps.paused;
  if (paused !== false) {
    return { ok: false, reason: "policy_still_paused", paused };
  }
  advanceLifecycle(operationId, CANARY_STATES.OWNER_UNPAUSED, {
    env,
    storeDir: sd,
    outcome: { verified_unpaused: true },
  });
  return { ok: true, stage: CANARY_STATES.OWNER_UNPAUSED };
}

export async function mission1StepPropose({
  operationId,
  env = process.env,
  storeDir = null,
  invoke = false,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const v = validateMission1CanaryApproval(operationId, {
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
  if (state !== CANARY_STATES.OWNER_UNPAUSED) {
    return { ok: false, reason: `bad_state:${state}` };
  }
  const args = v.record.outcomes?.[CANARY_STATES.ATTESTED]?.propose_args;
  if (!args) return { ok: false, reason: "propose_args_missing" };
  if (String(args.tx?.chain_id) !== String(MISSION1_CHAIN_ID)) {
    return { ok: false, reason: "wrong_chain" };
  }
  if (String(args.tx?.token_contract).toLowerCase() !== MISSION1_TOKEN) {
    return { ok: false, reason: "wrong_token" };
  }
  if (!invoke) {
    return { ok: true, dry: true, propose_args: args, note: "Pass invoke:true after confirm" };
  }
  if (deps.paused !== false) return { ok: false, reason: "policy_re_paused" };
  if (deps.existingPending?.payload_commitment) {
    return { ok: false, reason: "already_on_chain_reserved" };
  }
  const claim = tryClaimExecution(operationId, "propose", { env, storeDir: sd });
  if (!claim.ok) return claim;
  try {
    const res = deps.proposeFn
      ? await deps.proposeFn(args)
      : { ok: false, reason: "propose_adapter_missing" };
    if (!res?.ok && res?.transaction_hash == null && !res?.ok) {
      if (res?.reason) return res;
    }
    advanceLifecycle(operationId, CANARY_STATES.PROPOSED, {
      env,
      storeDir: sd,
      outcome: { near_tx: res.transaction_hash || res.near_tx || null },
    });
    return { ok: true, stage: CANARY_STATES.PROPOSED, near_tx: res.transaction_hash || null };
  } finally {
    releaseExecutionClaim(operationId, "propose", { env, storeDir: sd });
  }
}

export async function mission1StepRequestSignature({
  operationId,
  env = process.env,
  storeDir = null,
  invoke = false,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const v = validateMission1CanaryApproval(operationId, { env, storeDir: sd });
  if (!v.ok) return { ok: false, reason: v.reason };
  const need = requireOperatorConfirmation(v.record, "sign");
  if (!need.ok) return { ok: false, reason: need.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.PROPOSED) {
    return { ok: false, reason: `bad_state:${getLifecycleState(v.record)}` };
  }
  if (deps.paused !== false && invoke) {
    return { ok: false, reason: "policy_re_paused" };
  }
  const digest = v.record.locked_digest_hex;
  if (!digest) return { ok: false, reason: "digest_not_locked" };
  if (!invoke) {
    return { ok: true, dry: true, digest_hex: digest, note: "Pass invoke:true after confirm" };
  }
  const res = deps.signFn
    ? await deps.signFn(operationId)
    : { ok: false, reason: "sign_adapter_missing" };
  if (!res?.ok && !res?.transaction_hash) {
    return res?.reason ? res : { ok: false, reason: "sign_failed", detail: res };
  }
  const mpcDigest = deps.mpcDigestHex || digest;
  if (String(mpcDigest).toLowerCase() !== String(digest).toLowerCase()) {
    return { ok: false, reason: "mpc_digest_mismatch" };
  }
  advanceLifecycle(operationId, CANARY_STATES.MPC_SIGNED, {
    env,
    storeDir: sd,
    outcome: { near_sign_tx: res.transaction_hash || null, digest_hex: digest },
  });
  return { ok: true, stage: CANARY_STATES.MPC_SIGNED, digest_hex: digest };
}

/**
 * Persist identical signed raw bytes to durable journal BEFORE any broadcast.
 */
export function mission1StepPersistSignedRaw({
  operationId,
  signedRawHex,
  env = process.env,
  storeDir = null,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const v = validateMission1CanaryApproval(operationId, { env, storeDir: sd });
  if (!v.ok) return { ok: false, reason: v.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.MPC_SIGNED) {
    return { ok: false, reason: `bad_state:${getLifecycleState(v.record)}` };
  }
  if (!signedRawHex) return { ok: false, reason: "signed_raw_required" };
  const journal =
    deps.journal ||
    openTxJournal({
      path:
        deps.journalPath ||
        join(homedir(), ".nio-secure", "mainnet-mission1", "tx.sqlite"),
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
      chain_id: String(MISSION1_CHAIN_ID),
      to: MISSION1_TOKEN,
      data_hash: createHash("sha256")
        .update(String(v.record.locked_digest_hex || ""))
        .digest("hex"),
    });
  }
  const hash = localTxHash(signedRawHex);
  journal.markSigned(id, { signedRawHex });
  advanceLifecycle(operationId, CANARY_STATES.READY_TO_BROADCAST, {
    env,
    storeDir: sd,
    outcome: { local_tx_hash: hash, journal_id: id },
  });
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
export async function mission1StepBroadcast({
  operationId,
  env = process.env,
  storeDir = null,
  invoke = false,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const v = validateMission1CanaryApproval(operationId, {
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
  const deadlineMs =
    v.record.outcomes?.[CANARY_STATES.ATTESTED]?.quote_deadline_ms ||
    v.record.outcomes?.[CANARY_STATES.QUOTE_VERIFIED]?.quote_deadline_ms;
  if (
    deadlineMs != null &&
    deadlineMs <= Date.now() + MISSION1_QUOTE_DEADLINE_MIN_REMAINING_MS
  ) {
    return { ok: false, reason: "quote_expired_before_broadcast" };
  }
  if (deps.paused !== false && invoke) {
    return { ok: false, reason: "policy_re_paused" };
  }
  if (!invoke) {
    return { ok: true, dry: true, note: "Pass invoke:true after confirm" };
  }

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
    [TX_STATE.BROADCAST, TX_STATE.CONFIRMED, TX_STATE.SETTLEMENT_PENDING, TX_STATE.SETTLED].includes(
      cur.state
    )
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
  if (deps.expectedNonce != null && Number(v.record.locked_nonce) !== Number(deps.expectedNonce)) {
    return { ok: false, reason: "wrong_nonce" };
  }

  journal.beginBroadcast(operationId);
  let send;
  try {
    send = deps.ethSend
      ? await deps.ethSend(raw)
      : { error: { message: "eth_send_adapter_missing" } };
  } catch (e) {
    journal.markUnknown(operationId, { rpc_error: String(e.message || e).slice(0, 200) });
    return {
      ok: false,
      reason: "broadcast_rpc_timeout_or_error",
      may_resign: false,
      status: TX_STATE.UNKNOWN,
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
    return { ok: false, reason: "BROADCAST_FAILED", may_resign: false, error: send?.error };
  }
  journal.markBroadcast(operationId, send.result);
  bindBroadcastHash(operationId, send.result, { env, storeDir: sd });
  advanceLifecycle(operationId, CANARY_STATES.BROADCASTED, {
    env,
    storeDir: sd,
    outcome: { broadcast_hash: send.result },
  });
  advanceLifecycle(operationId, CANARY_STATES.SETTLEMENT_PENDING, {
    env,
    storeDir: sd,
    outcome: { broadcast_hash: send.result },
  });
  return {
    ok: true,
    stage: CANARY_STATES.SETTLEMENT_PENDING,
    broadcast_hash: send.result,
    may_resign: false,
  };
}

export async function mission1StepSettle({
  operationId,
  env = process.env,
  storeDir = null,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  const v = validateMission1CanaryApproval(operationId, { env, storeDir: sd });
  // Allow used=false or post-broadcast; validateMission1 rejects used — load carefully
  let record = v.record;
  if (!v.ok && v.reason === "approval_already_used") {
    // settlement may run after consume in some flows; prefer unused until SETTLED
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

  const settled = await verifyMission1Settlement({
    txHash,
    depositAddress: deposit,
    amount: MISSION1_AMOUNT,
    minAmountOut: minOut,
    nearUsdcBefore: record.near_usdc_before,
    ethRpcUrl: deps.ethRpc || MAINNET_EVM_RPCS.ethereum,
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
  advanceLifecycle(operationId, CANARY_STATES.SETTLED, {
    env,
    storeDir: sd,
    outcome: {
      near_delta: settled.destination?.delta,
      min_out: minOut,
      evidence_hash:
        deps.evidenceHash ||
        createHash("sha256")
          .update(`${txHash}:${settled.destination?.delta}:${minOut}`)
          .digest("hex"),
    },
  });
  consumeCanaryApproval(operationId, { env, storeDir: sd, reason: "settled" });
  return {
    ok: true,
    stage: CANARY_STATES.SETTLED,
    ...settled,
    note: "reconcile_pending is a separate owner-Ledger confirmation",
  };
}

export async function mission1StepReconcilePending({
  operationId,
  env = process.env,
  storeDir = null,
  invoke = false,
  evidenceHash = null,
  deps = {},
} = {}) {
  const sd = dirOf(env, storeDir);
  // After SETTLED approval is consumed — load file directly
  const { readFileSync, existsSync } = await import("node:fs");
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
  if (deps.reconcileFn) {
    const res = await deps.reconcileFn({
      operation_id: operationId,
      settlement_state: "Success",
      evidence_hash: hash,
    });
    if (!res?.ok) return { ok: false, reason: "reconcile_failed", detail: res };
  } else {
    return { ok: false, reason: "reconcile_adapter_missing_use_ledger" };
  }
  // Advance via raw write (approval consumed)
  const next = {
    ...record,
    lifecycle_state: CANARY_STATES.RECONCILED,
    outcomes: {
      ...record.outcomes,
      [CANARY_STATES.RECONCILED]: {
        at: new Date().toISOString(),
        evidence_hash: hash,
      },
    },
  };
  atomicWrite(path, next);
  return { ok: true, stage: CANARY_STATES.RECONCILED, evidence_hash: hash };
}

export async function mission1StepVerifyPaused({
  deps = {},
} = {}) {
  if (deps.paused !== true) {
    return { ok: false, reason: "policy_not_paused", paused: deps.paused };
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
 * Map step name → function for readiness / operator CLI.
 */
export const MISSION1_STEP_HANDLERS = Object.freeze({
  prepareApproval: mission1StepPrepareApproval,
  quoteAttest: mission1StepQuoteAttest,
  verifyUnpaused: mission1StepVerifyUnpaused,
  propose: mission1StepPropose,
  requestSignature: mission1StepRequestSignature,
  persistSignedRaw: mission1StepPersistSignedRaw,
  broadcast: mission1StepBroadcast,
  settle: mission1StepSettle,
  reconcilePending: mission1StepReconcilePending,
  verifyPaused: mission1StepVerifyPaused,
});

export function assertMission1RunnerComplete() {
  const missing = MISSION1_RUNNER_STEPS.filter((s) => typeof MISSION1_STEP_HANDLERS[s] !== "function");
  return {
    ok: missing.length === 0,
    missing,
    steps: listMission1RunnerSteps(),
    capabilities: mission1RunnerCapabilities(),
  };
}
