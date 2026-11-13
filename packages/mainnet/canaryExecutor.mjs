/**
 * J8B-1 — sequential one-shot canary executor (DISABLED by default).
 *
 * State machine:
 * PREPARED → QUOTE_VERIFIED → ATTESTED → OWNER_UNPAUSED → PROPOSED →
 * MPC_SIGNED → READY_TO_BROADCAST → BROADCASTED → SETTLEMENT_PENDING →
 * SETTLED | REFUNDED | FAILED
 *
 * Each mutation requires a NEW operator confirmation AFTER the prior outcome.
 * Production path forbids fixture injection and signedRawHex bypass.
 * Adapters are real but NEVER auto-invoked by a single command.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  createCanaryApproval,
  bindQuoteToApproval,
  validateCanaryApproval,
  requireOperatorConfirmation,
  consumeCanaryApproval,
  buildCanaryUnlockContext,
  advanceLifecycle,
  bindTxAuthorization,
  bindBroadcastHash,
  setBaseUsdcBefore,
  tryClaimExecution,
  releaseExecutionClaim,
  windowStatusReport,
  getLifecycleState,
  resolveCanaryJournalSecret,
  validateExecutableApproval,
  loadRecoveryAuthorization,
  QUOTE_DEADLINE_MIN_REMAINING_MS,
  CANARY_STATES,
  CANARY_AMOUNT,
  CANARY_ASSET_IN,
  CANARY_ASSET_OUT,
  CANARY_ATTESTOR_PK,
  CANARY_TOKEN,
  CANARY_CHAIN_ID,
} from "./canaryOneShot.mjs";
import {
  assertMainnetBroadcastAllowed,
  mainnetExecutionGates,
  resolveCanaryUnlock,
} from "./safetyGates.mjs";
import { productionDryQuote } from "./intents.mjs";
import {
  attestTidepoolQuote,
  publicKeyEd25519,
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
  MAINNET_IDENTITIES,
  MAINNET_EVM_RPCS,
  MAINNET_USDC,
} from "./identities.mjs";
import { chooseGasParams } from "./j8a.preflight.mjs";
import {
  estimateErc20TransferGas,
  fetchArbitrumGasPrice,
} from "./arbitrumFunding.mjs";
import { evmNativeBalance, evmErc20Balance } from "./evmBalances.mjs";
import { MAINNET_1CLICK } from "../execution/chainProfiles.mjs";
import { broadcastWithJournal } from "../execution/durableBroadcast.mjs";
import { openTxJournal, localTxHash, TX_STATE } from "../execution/txJournal.mjs";
import {
  verifySourceUsdcTransfer,
  monitorOneClickByDeposit,
  verifyBaseUsdcDelta,
  settlementRecoverySteps,
} from "./canarySettlement.mjs";
import { createMainnetCanaryAdapters } from "./canaryAdapters.mjs";
import {
  buildLedgerRunbook,
  buildReconcileLedgerCommand,
} from "./canaryLedgerRunbook.mjs";
import {
  waitForPendingOp,
  assertProposeForbiddenForRecovery,
} from "./canaryRecovery.mjs";

function openCanaryJournal({ env, storeDir, deps = {} }) {
  if (deps.journal) return { ok: true, journal: deps.journal };
  const sec = resolveCanaryJournalSecret({ env, storeDir });
  if (!sec.ok) return sec;
  const journalPath =
    deps.journalPath ||
    join(
      storeDir || join(homedir(), ".nio-secure", "mainnet-canary"),
      "tx-journal.sqlite"
    );
  return {
    ok: true,
    journal: openTxJournal({ path: journalPath, secret: sec.secret }),
    journalPath,
    secret_source: sec.source,
  };
}

function extractQuoteDeadlineMs(quoteResult) {
  const raw =
    quoteResult?.one_click_response?.quote?.deadline ||
    quoteResult?.deadline ||
    quoteResult?.one_click_response?.quoteRequest?.deadline ||
    null;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function assertQuoteDeadlineFresh(record, { nowMs = Date.now(), minRemainingMs = QUOTE_DEADLINE_MIN_REMAINING_MS } = {}) {
  const deadlineMs =
    record?.outcomes?.[CANARY_STATES.QUOTE_VERIFIED]?.quote_deadline_ms ||
    record?.outcomes?.[CANARY_STATES.ATTESTED]?.quote_deadline_ms ||
    record?.payload?.quote_deadline_ms ||
    null;
  if (deadlineMs == null) {
    return { ok: false, reason: "quote_deadline_missing" };
  }
  const remaining = Number(deadlineMs) - nowMs;
  if (remaining <= 0) {
    return { ok: false, reason: "quote_deadline_expired", deadline_ms: deadlineMs };
  }
  if (remaining < minRemainingMs) {
    return {
      ok: false,
      reason: "quote_deadline_too_close",
      remaining_ms: remaining,
      min_remaining_ms: minRemainingMs,
    };
  }
  return { ok: true, deadline_ms: deadlineMs, remaining_ms: remaining };
}

function loadAttestor() {
  const latest = join(
    homedir(),
    ".nio-secure",
    "mainnet-attestor",
    "LATEST_ATTESTOR_PATH.txt"
  );
  if (!existsSync(latest)) throw new Error("attestor_not_generated");
  const seedPath = readFileSync(latest, "utf8").trim();
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  const sk = Buffer.from(seed.secretKey64, "base64");
  const pk = publicKeyEd25519(sk);
  if (pk !== seed.publicKey || pk !== CANARY_ATTESTOR_PK) {
    throw new Error("attestor_key_mismatch");
  }
  return { publicKey: pk, secretKey64: sk };
}

function assertProductionDeps(deps, testHarness) {
  if (testHarness) return;
  const forbidden = [
    "quoteResult",
    "attestResult",
    "signedRawHex",
    "gasEst",
    "limits",
    "ethBal",
    "usdcBal",
  ];
  for (const k of forbidden) {
    if (deps?.[k] != null) {
      throw new Error(`production_forbids_injected_dep:${k}`);
    }
  }
}

function report(extra = {}) {
  return {
    mutations_invoked: false,
    ...extra,
  };
}

export async function prepareCanaryOperation(opts = {}) {
  const env = opts.env || process.env;
  const gates = mainnetExecutionGates(env);
  if (gates.autonomous_execution_enabled) {
    return { ok: false, reason: "autonomous_must_stay_false" };
  }
  const created = createCanaryApproval({
    operationId: opts.operationId,
    maxGasPrice: opts.maxGasPrice,
    ttlMs: opts.ttlMs,
    env,
    storeDir: opts.storeDir,
  });
  return {
    ok: true,
    stage: CANARY_STATES.PREPARED,
    operation_id: created.operation_id,
    fingerprint: created.fingerprint,
    expires_at: created.expires_at,
    path: created.path,
    gates_default: gates,
    window: windowStatusReport({
      policyPausedOnchain: null,
      broadcastStatus: "not_sent",
      lifecycle: CANARY_STATES.PREPARED,
    }),
    note: "Next: canaryStepQuoteAttest after operator reviews economics",
  };
}

/**
 * Step: fetch live quote + attest + bind approval. No chain mutation.
 */
export async function canaryStepQuoteAttest({
  operationId,
  env = process.env,
  storeDir = null,
  testHarness = false,
  deps = {},
} = {}) {
  assertProductionDeps(deps, testHarness);
  const v = validateCanaryApproval(operationId, { env, storeDir });
  if (!v.ok) return { ok: false, reason: v.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.PREPARED) {
    return {
      ok: false,
      reason: `bad_state:${getLifecycleState(v.record)}`,
    };
  }

  const mpc = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
  const arbRpc = deps.arbRpc || MAINNET_EVM_RPCS.arbitrum;
  const baseRpc = deps.baseRpc || MAINNET_EVM_RPCS.base;

  // Live policy limits (production) or harness limits
  let limits = deps.limits;
  if (!limits) {
    if (deps.adapters?.getLimits) limits = await deps.adapters.getLimits();
    else {
      // Read-only view without full adapter boot
      const { pickRpc, viewFunction } = await import("../networks/rpc.mjs");
      const { MAINNET } = await import("../networks/profiles.mjs");
      const rpc = await pickRpc(MAINNET.near.rpcs);
      limits = await viewFunction(rpc, MAINNET_IDENTITIES.policy, "get_limits", {});
    }
  }

  let epoch = 2;
  if (deps.adapters?.getMandateEpoch) {
    epoch = await deps.adapters.getMandateEpoch();
  }
  if (Number(epoch) !== 2) {
    return { ok: false, reason: "mandate_epoch_mismatch", epoch };
  }

  const ethBal =
    deps.ethBal ||
    (await evmNativeBalance(arbRpc, mpc));
  const usdcBal =
    deps.usdcBal ||
    (await evmErc20Balance(arbRpc, CANARY_TOKEN, mpc));
  const baseBefore =
    deps.baseUsdcBefore ||
    (await evmErc20Balance(baseRpc, MAINNET_USDC.base, mpc));
  if (!ethBal.ok || !usdcBal.ok || BigInt(usdcBal.raw) < BigInt(CANARY_AMOUNT)) {
    return { ok: false, reason: "insufficient_balances" };
  }
  setBaseUsdcBefore(operationId, baseBefore.raw, { env, storeDir });

  let quoteResult = deps.quoteResult;
  if (!quoteResult) {
    const prev = env.NIO_MAINNET_ALLOW_FUNDED_QUOTE;
    env.NIO_MAINNET_ALLOW_FUNDED_QUOTE = "1";
    try {
      quoteResult = await productionDryQuote(
        {
          originAsset: CANARY_ASSET_IN,
          destinationAsset: CANARY_ASSET_OUT,
          amount: CANARY_AMOUNT,
          slippageTolerance: 25,
          recipient: mpc,
          refundTo: mpc,
        },
        { allowFundedQuote: true }
      );
    } finally {
      if (prev === undefined) delete env.NIO_MAINNET_ALLOW_FUNDED_QUOTE;
      else env.NIO_MAINNET_ALLOW_FUNDED_QUOTE = prev;
    }
  }
  if (
    !quoteResult?.ok ||
    !quoteResult.one_click_verify?.ok ||
    !quoteResult.one_click_verify?.escrow_in_signed_hash
  ) {
    return { ok: false, reason: "quote_verify_failed", quote: quoteResult };
  }

  const floor = evaluateLiveMinOutAgainstPolicy({
    amountIn: quoteResult.amount_in,
    minAmountOut: quoteResult.min_amount_out,
    maxSlippageBps: Number(limits.max_slippage_bps || 100),
  });
  if (floor.result !== "PASS") {
    return { ok: false, reason: "policy_floor_blocked", floor };
  }

  bindQuoteToApproval(operationId, {
    quoteHash: quoteResult.one_click_verify.quote_hash,
    depositAddress: quoteResult.deposit_address,
    env,
    storeDir,
  });
  const quoteDeadlineMs = extractQuoteDeadlineMs(quoteResult);
  advanceLifecycle(operationId, CANARY_STATES.QUOTE_VERIFIED, {
    env,
    storeDir,
    outcome: {
      quote_hash: quoteResult.one_click_verify.quote_hash,
      deposit: quoteResult.deposit_address,
      min_out: quoteResult.min_amount_out,
      quote_deadline_ms: quoteDeadlineMs,
      quote_deadline: quoteResult?.one_click_response?.quote?.deadline || null,
    },
  });

  const gasPriceJ =
    deps.gasPrice || (await fetchArbitrumGasPrice(arbRpc));
  const gasEst =
    deps.gasEst ||
    (await estimateErc20TransferGas(arbRpc, {
      from: mpc,
      token: CANARY_TOKEN,
      to: quoteResult.deposit_address,
      amountRaw: CANARY_AMOUNT,
    }));
  if (!gasEst.ok || !gasPriceJ.ok) {
    return { ok: false, reason: "gas_estimate_failed" };
  }
  const gasParams = chooseGasParams({
    liveGasPriceWei: gasPriceJ.wei,
    estimatedGas: gasEst.gas,
    ethBalanceWei: ethBal.wei,
  });
  if (!gasParams.ok) return { ok: false, reason: "gas_params_blocked", gasParams };

  const attestor = deps.attestor || loadAttestor();
  let attestResult = deps.attestResult;
  if (!attestResult) {
    attestResult = attestTidepoolQuote({
      quoteResponse: quoteResult.one_click_response,
      agentRequest: {
        originAsset: CANARY_ASSET_IN,
        destinationAsset: CANARY_ASSET_OUT,
        amount: CANARY_AMOUNT,
        depositType: "ORIGIN_CHAIN",
        recipient: mpc,
        refundTo: mpc,
      },
      tokenContract: CANARY_TOKEN,
      chainId: CANARY_CHAIN_ID,
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
  if (!attestResult.ok) {
    return { ok: false, reason: "attestation_failed", attest: attestResult };
  }

  let localSigOk = false;
  try {
    localSigOk = nacl.sign.detached.verify(
      Buffer.from(attestResult.message_utf8, "utf8"),
      bs58.decode(attestResult.signature.replace(/^ed25519:/, "")),
      nacl.sign.keyPair.fromSecretKey(attestor.secretKey64).publicKey
    );
  } catch {
    localSigOk = false;
  }
  if (!localSigOk) return { ok: false, reason: "attestation_sig_invalid" };

  let nonceFinal = deps.nonce;
  if (nonceFinal == null) {
    const { ethJsonRpc } = await import("./canaryAdapters.mjs");
    const nj = await ethJsonRpc(arbRpc, "eth_getTransactionCount", [
      mpc,
      "pending",
    ]);
    nonceFinal = Number(BigInt(nj.result || "0x0"));
  } else {
    nonceFinal = Number(nonceFinal);
  }

  const policyTx = buildErc20TxParams({
    depositAddress: attestResult.attestation.deposit_address,
    tokenContract: attestResult.attestation.token_contract,
    amountIn: attestResult.attestation.amount_in,
    chainId: CANARY_CHAIN_ID,
    nonce: nonceFinal,
    gasPrice: gasParams.gas_price,
    gasLimit: gasParams.gas_limit,
  });

  if (policyTx.to !== String(quoteResult.deposit_address).toLowerCase()) {
    return { ok: false, reason: "wrong_escrow" };
  }
  if (policyTx.token_contract !== CANARY_TOKEN) {
    return { ok: false, reason: "wrong_token" };
  }
  if (String(policyTx.amount) !== CANARY_AMOUNT) {
    return { ok: false, reason: "wrong_amount" };
  }

  const data = erc20TransferData(
    attestResult.attestation.deposit_address,
    CANARY_AMOUNT
  );
  const digest_hex = digestHex(
    eip155UnsignedDigest({
      nonce: nonceFinal,
      gasPrice: BigInt(gasParams.gas_price),
      gasLimit: BigInt(gasParams.gas_limit),
      to: CANARY_TOKEN,
      data,
      chainId: CANARY_CHAIN_ID,
    })
  );
  if (digest_hex !== policyTx.digest_hex) {
    return { ok: false, reason: "digest_mismatch" };
  }

  const policySim = simulatePolicyChecks({
    attestation: attestResult.attestation,
    tx: policyTx,
    expectedEpoch: 2,
    mandateEpoch: Number(epoch),
    allowedAssets: new Set(limits.allowed_assets),
    allowedDestinations: new Set(
      limits.allowed_destinations.map((d) => String(d).toLowerCase())
    ),
    allowedChains: new Set([42161]),
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

  bindTxAuthorization(operationId, {
    nonce: nonceFinal,
    digestHex: digest_hex,
    gasPrice: gasParams.gas_price,
    gasLimit: gasParams.gas_limit,
    env,
    storeDir,
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
      chain_id: String(CANARY_CHAIN_ID),
      token_contract: CANARY_TOKEN,
      to: attestResult.attestation.deposit_address,
      amount: CANARY_AMOUNT,
    },
    expected_epoch: 2,
  };

  advanceLifecycle(operationId, CANARY_STATES.ATTESTED, {
    env,
    storeDir,
    outcome: {
      attestation_id: attestResult.attestation_id,
      digest_hex,
      nonce: nonceFinal,
      min_out: quoteResult.min_amount_out,
      propose_args: proposeArgs,
      quote_deadline_ms: quoteDeadlineMs,
    },
  });

  return report({
    ok: true,
    stage: CANARY_STATES.ATTESTED,
    operation_id: operationId,
    quote: {
      quote_hash: quoteResult.one_click_verify.quote_hash,
      deposit_address: quoteResult.deposit_address,
      amount_in: quoteResult.amount_in,
      amount_out: quoteResult.amount_out,
      min_amount_out: quoteResult.min_amount_out,
    },
    gas: gasParams,
    digest_hex,
    nonce: nonceFinal,
    propose_args: proposeArgs,
    base_usdc_before: baseBefore.raw,
    next: "Owner Ledger unpause(); then canaryStepVerifyUnpaused; then confirm propose",
    ledger: buildLedgerRunbook(),
    window: windowStatusReport({
      policyPausedOnchain: null,
      broadcastStatus: "not_sent",
      lifecycle: CANARY_STATES.ATTESTED,
    }),
  });
}

/** Verify on-chain paused=false after owner Ledger unpause (read-only). */
export async function canaryStepVerifyUnpaused({
  operationId,
  env = process.env,
  storeDir = null,
  adapters = null,
  testHarness = false,
  deps = {},
} = {}) {
  const v = validateCanaryApproval(operationId, {
    env,
    storeDir,
    requireQuoteBound: true,
  });
  if (!v.ok) return { ok: false, reason: v.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.ATTESTED) {
    return { ok: false, reason: `bad_state:${getLifecycleState(v.record)}` };
  }

  let paused;
  if (deps.paused != null) paused = Boolean(deps.paused);
  else {
    const a = adapters || (testHarness ? null : await createMainnetCanaryAdapters({ env }));
    if (!a) return { ok: false, reason: "adapters_required" };
    paused = await a.getPaused();
  }

  if (paused !== false) {
    return {
      ok: false,
      reason: "policy_still_paused",
      window: windowStatusReport({
        policyPausedOnchain: true,
        lifecycle: CANARY_STATES.ATTESTED,
      }),
    };
  }

  advanceLifecycle(operationId, CANARY_STATES.OWNER_UNPAUSED, {
    env,
    storeDir,
    outcome: { paused: false },
  });

  return {
    ok: true,
    stage: CANARY_STATES.OWNER_UNPAUSED,
    window: windowStatusReport({
      policyPausedOnchain: false,
      owner_pause_required: true,
      lifecycle: CANARY_STATES.OWNER_UNPAUSED,
    }),
    next: "CLI confirm --phase propose then canaryStepPropose",
  };
}

/** Propose — requires confirm AFTER OWNER_UNPAUSED. Never auto-resubmit. */
export async function canaryStepPropose({
  operationId,
  proposeArgs = null,
  env = process.env,
  storeDir = null,
  adapters = null,
  invoke = false,
  testHarness = false,
  deps = {},
} = {}) {
  // Confirmations are recorded ONLY by CLI `confirm` — never auto-recorded here.
  const recovery = loadRecoveryAuthorization(operationId, { env, storeDir });
  if (recovery.ok) {
    return {
      ok: false,
      reason: "propose_forbidden_recovery_auth_exists",
      note: "Resume at sign; never call propose_quoted_evm_transfer again",
    };
  }

  const v = validateCanaryApproval(operationId, {
    env,
    storeDir,
    requireQuoteBound: true,
  });
  if (!v.ok) return { ok: false, reason: v.reason };
  const forbid = assertProposeForbiddenForRecovery(v.record);
  if (!forbid.ok) return forbid;
  const need = requireOperatorConfirmation(v.record, "propose");
  if (!need.ok) return { ok: false, reason: need.reason };

  const state = getLifecycleState(v.record);
  if (state === CANARY_STATES.RECONCILIATION_REQUIRED) {
    return {
      ok: false,
      reason: "reconciliation_required_no_resubmit",
      note: "Inspect on-chain PendingOp; create recovery auth or abort — never re-propose",
    };
  }
  if (state === CANARY_STATES.PROPOSED) {
    return {
      ok: false,
      reason: "already_proposed_no_resubmit",
    };
  }
  if (state !== CANARY_STATES.OWNER_UNPAUSED) {
    return { ok: false, reason: `bad_state:${state}` };
  }

  const args =
    proposeArgs ||
    v.record.outcomes?.[CANARY_STATES.ATTESTED]?.propose_args ||
    null;
  if (!args?.attestation || !args?.attestation_signature) {
    return { ok: false, reason: "propose_args_missing_rerun_quote_step" };
  }

  const a =
    adapters ||
    deps.adapters ||
    (testHarness ? null : await createMainnetCanaryAdapters({ env }));
  if (!invoke) {
    return {
      ok: true,
      dry: true,
      stage: CANARY_STATES.OWNER_UNPAUSED,
      propose_args: args,
      note: "Pass invoke:true only after reviewing propose_args",
    };
  }
  if (!a?.proposeQuotedEvmTransfer) {
    return { ok: false, reason: "near_propose_adapter_missing" };
  }

  const claim = tryClaimExecution(operationId, deps.workerId || "propose", {
    env,
    storeDir,
  });
  if (!claim.ok) return claim;

  try {
    const paused = await a.getPaused();
    if (paused !== false) return { ok: false, reason: "policy_re_paused" };
    const epoch = await a.getMandateEpoch();
    if (Number(epoch) !== 2) return { ok: false, reason: "epoch_changed" };

    // Refuse duplicate propose if already reserved on-chain
    const existing =
      deps.existingPending !== undefined
        ? deps.existingPending
        : await a.getPending(operationId);
    if (existing?.payload_commitment) {
      return {
        ok: false,
        reason: "already_on_chain_reserved",
        pending: existing,
        note: "Do not resubmit propose; use inspect + recovery auth",
      };
    }

    const res = await a.proposeQuotedEvmTransfer(args);
    const digest = v.record.locked_digest_hex;
    const verified = await waitForPendingOp({
      adapters: a,
      operationId,
      expectedDigest: digest,
      attempts: deps.pendingAttempts ?? 8,
      delayMs: deps.pendingDelayMs ?? 750,
      sleepFn: deps.sleepFn,
    });

    if (verified.ok) {
      advanceLifecycle(operationId, CANARY_STATES.PROPOSED, {
        env,
        storeDir,
        outcome: {
          near_tx: res.transaction_hash,
          payload_commitment: verified.pending.payload_commitment,
          pending_source: verified.source,
          pending_attempts: verified.attempts,
        },
      });
      return {
        ok: true,
        stage: CANARY_STATES.PROPOSED,
        propose: res,
        pending: verified.pending,
        mutations_invoked: true,
        next: "Review propose outcome; CLI confirm --phase sign; canaryStepRequestSignature",
        window: windowStatusReport({
          policyPausedOnchain: false,
          lifecycle: CANARY_STATES.PROPOSED,
        }),
      };
    }

    if (verified.reason === "payload_commitment_mismatch") {
      advanceLifecycle(operationId, CANARY_STATES.FAILED, {
        env,
        storeDir,
        outcome: {
          reason: "payload_commitment_mismatch",
          near_tx: res.transaction_hash,
          pending: verified.pending,
        },
      });
      consumeCanaryApproval(operationId, {
        env,
        storeDir,
        reason: "payload_commitment_mismatch",
      });
      return {
        ok: false,
        reason: "payload_commitment_mismatch",
        pending: verified.pending,
        propose: res,
      };
    }

    // Null / stale RPC — reconciliation required. Do NOT consume as mismatch.
    // Do NOT resubmit propose.
    advanceLifecycle(operationId, CANARY_STATES.RECONCILIATION_REQUIRED, {
      env,
      storeDir,
      outcome: {
        reason: verified.reason || "pending_op_temporarily_unverified",
        near_tx: res.transaction_hash,
        expected_digest: digest,
        attempts: verified.attempts,
      },
    });
    return {
      ok: false,
      reason: "reconciliation_required",
      stage: CANARY_STATES.RECONCILIATION_REQUIRED,
      propose: res,
      near_tx: res.transaction_hash,
      may_resubmit_propose: false,
      note: "Propose may have succeeded on-chain. Inspect get_pending/list_pending; never re-propose.",
      next: "canary inspect --op …; recovery-rehearsal; optionally create-recovery-auth",
    };
  } finally {
    releaseExecutionClaim(operationId, deps.workerId || "propose", {
      env,
      storeDir,
    });
  }
}

/** request_signature — requires confirm AFTER PROPOSED. */
export async function canaryStepRequestSignature({
  operationId,
  env = process.env,
  storeDir = null,
  adapters = null,
  invoke = false,
  testHarness = false,
  deps = {},
} = {}) {
  const v = validateExecutableApproval(operationId, {
    env,
    storeDir,
    requireQuoteBound: true,
    allowRecovery: true,
  });
  if (!v.ok) return { ok: false, reason: v.reason };
  const need = requireOperatorConfirmation(v.record, "sign");
  if (!need.ok) return { ok: false, reason: need.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.PROPOSED) {
    return { ok: false, reason: `bad_state:${getLifecycleState(v.record)}` };
  }

  if (!invoke) {
    return {
      ok: true,
      dry: true,
      is_recovery: Boolean(v.is_recovery),
      note: "Pass invoke:true to submit request_signature with 1 yocto (requires separate unpause window)",
    };
  }

  const a =
    adapters ||
    deps.adapters ||
    (testHarness ? null : await createMainnetCanaryAdapters({ env }));
  if (!a?.requestSignature) {
    return { ok: false, reason: "near_sign_adapter_missing" };
  }

  // Independent pre-sign recheck — never sign twice / never sign non-Reserved.
  if (typeof a.getPaused !== "function") {
    return { ok: false, reason: "near_pause_adapter_missing" };
  }
  if (typeof a.getMandateEpoch !== "function") {
    return { ok: false, reason: "near_epoch_adapter_missing" };
  }
  if (typeof a.getPending !== "function" && !deps.pendingPreSign) {
    return { ok: false, reason: "near_pending_adapter_missing" };
  }
  const paused = await a.getPaused();
  if (paused !== false) {
    return { ok: false, reason: "policy_not_unpaused_for_sign" };
  }
  const epoch = await a.getMandateEpoch();
  if (Number(epoch) !== 2) {
    return { ok: false, reason: "epoch_changed_before_sign", epoch };
  }
  const pendingPre =
    deps.pendingPreSign || (await a.getPending(operationId));
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
    String(v.record.locked_digest_hex || "").toLowerCase()
  ) {
    return { ok: false, reason: "payload_commitment_mismatch_before_sign" };
  }

  const res = await a.requestSignature(operationId);
  const full = res.transaction_hash
    ? await a.waitNearTx(res.transaction_hash)
    : deps.nearTxFull;
  if (!full && !deps.assembled) {
    return {
      ok: false,
      reason: "near_finality_pending",
      residual: true,
      propose_tx: res.transaction_hash,
      window: windowStatusReport({
        policyPausedOnchain: false,
        mpcSignatureOutstanding: true,
        broadcastStatus: "not_sent",
        lifecycle: CANARY_STATES.PROPOSED,
      }),
    };
  }

  const assembled =
    deps.assembled ||
    a.assembleEip155FromMpcNearTx({
      nearTxFull: full,
      nonce: v.record.locked_nonce,
      gasPrice: v.record.locked_gas_price,
      gasLimit: v.record.locked_gas_limit,
      depositAddress: v.payload.deposit_address,
      expectedDigestHex: v.record.locked_digest_hex,
    });

  if (!assembled.ok) {
    advanceLifecycle(operationId, CANARY_STATES.FAILED, {
      env,
      storeDir,
      outcome: assembled,
    });
    return { ok: false, ...assembled };
  }

  // Mandatory on-chain pending commitment check
  const pending = await a.getPending(operationId);
  if (
    !pending?.payload_commitment ||
    String(pending.payload_commitment).toLowerCase() !==
      assembled.digest_hex.toLowerCase()
  ) {
    return { ok: false, reason: "payload_commitment_mismatch_at_sign" };
  }

  const rawCheck = a.verifySignedRawAgainstAuth(assembled.rawHex, {
    token: CANARY_TOKEN,
    deposit_address: v.payload.deposit_address,
    amount: CANARY_AMOUNT,
    nonce: v.record.locked_nonce,
    gas_price: v.record.locked_gas_price,
    gas_limit: v.record.locked_gas_limit,
    chain_id: CANARY_CHAIN_ID,
    digest_hex: v.record.locked_digest_hex,
    mpc: MAINNET_IDENTITIES.mpc_evm_address,
  });
  if (!rawCheck.ok) return rawCheck;

  const lhash = localTxHash(assembled.rawHex);
  bindTxAuthorization(operationId, {
    nonce: v.record.locked_nonce,
    digestHex: assembled.digest_hex,
    localTxHash: lhash,
    gasPrice: v.record.locked_gas_price,
    gasLimit: v.record.locked_gas_limit,
    env,
    storeDir,
  });

  advanceLifecycle(operationId, CANARY_STATES.MPC_SIGNED, {
    env,
    storeDir,
    outcome: { recovered: assembled.recovered, local_tx_hash: lhash },
  });
  advanceLifecycle(operationId, CANARY_STATES.READY_TO_BROADCAST, {
    env,
    storeDir,
    outcome: { ready: true },
  });

  // Persist signed bytes BEFORE any send
  const opened = openCanaryJournal({ env, storeDir, deps });
  if (!opened.ok) return opened;
  const journal = opened.journal;
  journal.insertDraft({
    id: operationId,
    portfolio_id: MAINNET_IDENTITIES.portfolio_id,
    idempotency_key: `canary:${operationId}`,
    nonce: String(v.record.locked_nonce),
    chain_id: String(CANARY_CHAIN_ID),
    meta: {
      digest_hex: assembled.digest_hex,
      deposit: v.payload.deposit_address,
      quote_hash: v.payload.quote_hash,
    },
  });
  journal.markSigned(operationId, {
    signedRawHex: assembled.rawHex,
    meta: { local_tx_hash: lhash },
  });

  return {
    ok: true,
    stage: CANARY_STATES.READY_TO_BROADCAST,
    recovered: assembled.recovered,
    digest_hex: assembled.digest_hex,
    local_tx_hash: lhash,
    signed_persisted: true,
    // Do NOT return full raw hex to console by default
    raw_hex_present: true,
    mutations_invoked: true,
    next: "Review recovered signer; CLI confirm --phase broadcast; then canaryStepBroadcast",
    window: windowStatusReport({
      policyPausedOnchain: false,
      mpcSignatureOutstanding: true,
      broadcastStatus: "not_sent",
      lifecycle: CANARY_STATES.READY_TO_BROADCAST,
    }),
    _journal_path: opened.journalPath || null,
  };
}

/** Broadcast — requires prior CLI confirm; revalidates canary + exact raw tx from disk. */
export async function canaryStepBroadcast({
  operationId,
  env = process.env,
  storeDir = null,
  adapters = null,
  invoke = false,
  testHarness = false,
  deps = {},
} = {}) {
  const v = validateExecutableApproval(operationId, {
    env,
    storeDir,
    requireQuoteBound: true,
    allowRecovery: true,
  });
  if (!v.ok) return { ok: false, reason: v.reason };
  const need = requireOperatorConfirmation(v.record, "broadcast");
  if (!need.ok) return { ok: false, reason: need.reason };
  if (getLifecycleState(v.record) !== CANARY_STATES.READY_TO_BROADCAST) {
    return { ok: false, reason: `bad_state:${getLifecycleState(v.record)}` };
  }

  const unlock = resolveCanaryUnlock(
    {
      operationId,
      storeDir,
      requireQuoteBound: true,
      allowRecovery: true,
      expected: {
        digest_hex: v.record.locked_digest_hex,
        quote_hash: v.payload.quote_hash,
        deposit_address: v.payload.deposit_address,
      },
    },
    env
  );
  if (!unlock.ok) return { ok: false, reason: unlock.reason };

  const deadline = assertQuoteDeadlineFresh(v.record, {
    nowMs: deps.nowMs || Date.now(),
  });
  if (!deadline.ok) return deadline;

  if (!invoke) {
    return {
      ok: true,
      dry: true,
      quote_deadline: deadline,
      note: "Pass invoke:true to broadcast identical journal bytes once after raw-tx validation",
    };
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

  const opened = openCanaryJournal({ env, storeDir, deps });
  if (!opened.ok) return opened;
  const journal = opened.journal;
  const raw = journal.loadSignedRaw(operationId);
  if (!raw) return { ok: false, reason: "signed_bytes_missing_in_journal" };

  const a =
    adapters ||
    deps.adapters ||
    (testHarness ? null : await createMainnetCanaryAdapters({ env }));
  if (!a?.verifySignedRawAgainstAuth || !a?.getPending || !a?.eth) {
    return { ok: false, reason: "broadcast_adapters_incomplete" };
  }

  const pending = deps.pending || (await a.getPending(operationId));
  if (!pending?.payload_commitment) {
    return { ok: false, reason: "pending_op_missing_payload_commitment" };
  }

  const rawCheck = a.verifySignedRawAgainstAuth(raw, {
    token: CANARY_TOKEN,
    deposit_address: v.payload.deposit_address,
    amount: CANARY_AMOUNT,
    nonce: v.record.locked_nonce,
    gas_price: v.record.locked_gas_price,
    gas_limit: v.record.locked_gas_limit,
    chain_id: CANARY_CHAIN_ID,
    digest_hex: v.record.locked_digest_hex,
    mpc: MAINNET_IDENTITIES.mpc_evm_address,
    local_tx_hash: v.record.locked_local_tx_hash,
    payload_commitment: pending.payload_commitment,
  });
  if (!rawCheck.ok) {
    return {
      ok: false,
      ...rawCheck,
      may_resign: false,
      note: "Altered bytes or auth mismatch — never re-sign automatically",
    };
  }

  const broadcast = await broadcastWithJournal({
    journal,
    journalId: operationId,
    signedRawHex: raw,
    profile: MAINNET_1CLICK,
    eth: (method, params) => a.eth(method, params),
    opts: {
      dryRun: false,
      operationId,
      storeDir,
      env,
      allowRecovery: Boolean(v.is_recovery),
      depositBound: {
        deposit_address: v.payload.deposit_address,
        binding_ok: true,
      },
      token: CANARY_TOKEN,
      chainId: CANARY_CHAIN_ID,
      expected: {
        quote_hash: v.payload.quote_hash,
        deposit_address: v.payload.deposit_address,
        digest_hex: v.record.locked_digest_hex,
      },
    },
  });

  if (!broadcast.ok) {
    return {
      ok: false,
      reason: broadcast.reason || "broadcast_failed",
      residual_risk: true,
      may_resign: false,
      broadcast,
      window: windowStatusReport({
        policyPausedOnchain: false,
        mpcSignatureOutstanding: true,
        broadcastStatus:
          broadcast.status === TX_STATE.UNKNOWN ? "unknown" : "not_sent",
        lifecycle: CANARY_STATES.READY_TO_BROADCAST,
      }),
      settlement_recovery: settlementRecoverySteps("UNKNOWN"),
    };
  }

  bindBroadcastHash(operationId, broadcast.broadcast_hash, { env, storeDir });
  advanceLifecycle(operationId, CANARY_STATES.BROADCASTED, {
    env,
    storeDir,
    outcome: { broadcast_hash: broadcast.broadcast_hash },
  });
  advanceLifecycle(operationId, CANARY_STATES.SETTLEMENT_PENDING, {
    env,
    storeDir,
  });

  return {
    ok: true,
    stage: CANARY_STATES.SETTLEMENT_PENDING,
    broadcast_hash: broadcast.broadcast_hash,
    raw_verified: rawCheck,
    mutations_invoked: true,
    next: "Owner should Ledger pause() NOW (do not leave unpaused during settlement poll); then canaryStepSettle",
    window: windowStatusReport({
      policyPausedOnchain: false,
      owner_pause_required: true,
      mpcSignatureOutstanding: false,
      broadcastStatus: "verified",
      lifecycle: CANARY_STATES.SETTLEMENT_PENDING,
    }),
    ledger_pause: buildLedgerRunbook().pause_command,
  };
}

/**
 * Settlement: source receipt + 1Click by depositAddress + Base USDC delta.
 * Does NOT mark SETTLED without Base verification.
 */
export async function canaryStepSettle({
  operationId,
  env = process.env,
  storeDir = null,
  adapters = null,
  testHarness = false,
  deps = {},
} = {}) {
  const { resolveWritableApproval } = await import("./canaryOneShot.mjs");
  // Prefer unused recovery record; original FAILED/used stays immutable.
  const loaded = resolveWritableApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  const rec = loaded.record;
  if (getLifecycleState(rec) !== CANARY_STATES.SETTLEMENT_PENDING) {
    return { ok: false, reason: `bad_state:${getLifecycleState(rec)}` };
  }
  // Soft MAC check (used originals are not required here — recovery path)
  if (loaded.is_recovery) {
    const v = validateExecutableApproval(operationId, {
      env,
      storeDir,
      requireQuoteBound: true,
      allowRecovery: true,
    });
    // After broadcast, approval may still be unused until settle consumes
    if (!v.ok && v.reason !== "approval_already_used") {
      // Allow reading SETTLEMENT_PENDING even if partially progressed
      if (getLifecycleState(rec) !== CANARY_STATES.SETTLEMENT_PENDING) {
        return { ok: false, reason: v.reason };
      }
    }
  }

  const mpc = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
  const a =
    adapters ||
    deps.adapters ||
    (testHarness ? null : await createMainnetCanaryAdapters({ env }));

  const source =
    deps.sourceVerify ||
    (await verifySourceUsdcTransfer({
      txHash: rec.locked_broadcast_hash,
      mpc,
      escrow: rec.payload.deposit_address,
      amount: CANARY_AMOUNT,
      rpcUrl: a?.arbRpc || MAINNET_EVM_RPCS.arbitrum,
    }));

  const settle =
    deps.oneClick ||
    (await monitorOneClickByDeposit({
      depositAddress: rec.payload.deposit_address,
      maxPolls: deps.settlePolls || 3,
      pollFn: deps.oneClickStatus,
    }));

  if (!source.ok) {
    return {
      ok: false,
      reason: "source_receipt_failed",
      source,
      settlement_recovery: settlementRecoverySteps("FAILED"),
    };
  }

  if (!settle.terminal) {
    return {
      ok: false,
      reason: "settlement_incomplete",
      stage: CANARY_STATES.SETTLEMENT_PENDING,
      source,
      settlement: settle,
      settlement_recovery: settlementRecoverySteps(settle.normalized),
      note: "Persist pending; continue polling — do not mark SUCCESS",
    };
  }

  if (settle.normalized === "REFUNDED") {
    advanceLifecycle(operationId, CANARY_STATES.REFUNDED, { env, storeDir });
    consumeCanaryApproval(operationId, { env, storeDir, reason: "refunded" });
    return {
      ok: false,
      stage: CANARY_STATES.REFUNDED,
      source,
      settlement: settle,
      settlement_recovery: settlementRecoverySteps("REFUNDED"),
    };
  }

  if (settle.normalized !== "SUCCESS") {
    advanceLifecycle(operationId, CANARY_STATES.FAILED, { env, storeDir });
    consumeCanaryApproval(operationId, {
      env,
      storeDir,
      reason: `settle_${settle.normalized}`,
    });
    return {
      ok: false,
      stage: CANARY_STATES.FAILED,
      source,
      settlement: settle,
      settlement_recovery: settlementRecoverySteps(settle.normalized),
    };
  }

  // REQUIRED: Base USDC delta check before SETTLED
  const minOut =
    deps.minAmountOut ||
    rec.outcomes?.[CANARY_STATES.QUOTE_VERIFIED]?.min_out ||
    rec.outcomes?.[CANARY_STATES.ATTESTED]?.min_out ||
    rec.payload?.min_amount_out ||
    null;
  if (!minOut) {
    return { ok: false, reason: "min_amount_out_missing_for_base_check" };
  }

  const base =
    deps.baseVerify ||
    (await verifyBaseUsdcDelta({
      mpc,
      beforeRaw: rec.base_usdc_before || "0",
      minAmountOut: minOut,
      rpcUrl: a?.baseRpc || MAINNET_EVM_RPCS.base,
      token: MAINNET_USDC.base,
    }));

  if (!base.ok) {
    return {
      ok: false,
      reason: "base_usdc_delta_insufficient",
      stage: CANARY_STATES.SETTLEMENT_PENDING,
      source,
      settlement: settle,
      base,
      note: "1Click SUCCESS alone is NOT final — Base funds missing/short",
      settlement_recovery: settlementRecoverySteps("PENDING"),
    };
  }

  advanceLifecycle(operationId, CANARY_STATES.SETTLED, {
    env,
    storeDir,
    outcome: { base_delta: base.delta, min_out: minOut },
  });
  consumeCanaryApproval(operationId, { env, storeDir, reason: "settled" });

  return {
    ok: true,
    stage: CANARY_STATES.SETTLED,
    source,
    settlement: settle,
    base,
    note: "Final SUCCESS only after Base USDC delta verified. Policy reconcile_pending is a separate owner/reconciler confirmed mutation.",
    window: windowStatusReport({
      policyPausedOnchain: null,
      owner_pause_required: true,
      broadcastStatus: "verified",
      lifecycle: CANARY_STATES.SETTLED,
    }),
  };
}

/**
 * Policy reconcile_pending — SEPARATE confirmed mutation after SETTLED.
 * Agent may invoke ONLY if live get_reconciler() === agent. Otherwise owner Ledger path.
 * Never auto set_reconciler. Verify on-chain settlement_state before success.
 */
export async function canaryStepReconcilePending({
  operationId,
  env = process.env,
  storeDir = null,
  adapters = null,
  invoke = false,
  testHarness = false,
  deps = {},
  evidenceHash = null,
  settlementState = "Success",
} = {}) {
  const { resolveWritableApproval } = await import("./canaryOneShot.mjs");
  const loaded = resolveWritableApproval(operationId, { env, storeDir });
  if (!loaded.ok) return loaded;
  const need = requireOperatorConfirmation(loaded.record, "reconcile");
  if (!need.ok) return { ok: false, reason: need.reason };
  if (getLifecycleState(loaded.record) !== CANARY_STATES.SETTLED) {
    return { ok: false, reason: `bad_state:${getLifecycleState(loaded.record)}` };
  }

  const settled = loaded.record.outcomes?.[CANARY_STATES.SETTLED] || {};
  const hash =
    evidenceHash ||
    deps.evidenceHash ||
    settled.evidence_hash ||
    null;
  if (!hash) {
    return {
      ok: false,
      reason: "evidence_hash_required",
      note: "Build evidence from source tx + Base delta before reconcile",
    };
  }

  const a =
    adapters ||
    deps.adapters ||
    (testHarness ? null : await createMainnetCanaryAdapters({ env }));

  const reconciler =
    deps.reconciler !== undefined
      ? deps.reconciler
      : a?.getReconciler
        ? await a.getReconciler()
        : null;
  const agentIsReconciler =
    reconciler != null &&
    String(reconciler) === MAINNET_IDENTITIES.agent;

  const ownerCmd = buildReconcileLedgerCommand({
    operationId,
    settlementState,
    evidenceHash: hash,
    argsDir: storeDir || join(homedir(), ".nio-secure", "mainnet-canary"),
    signAs: MAINNET_IDENTITIES.owner,
  });

  if (!invoke) {
    return {
      ok: true,
      dry: true,
      method: "reconcile_pending",
      agent_is_reconciler: agentIsReconciler,
      on_chain_reconciler: reconciler,
      args: {
        operation_id: operationId,
        settlement_state: settlementState,
        evidence_hash: hash,
      },
      owner_reconcile: ownerCmd,
      note: agentIsReconciler
        ? "Agent is reconciler — --invoke allowed after explicit confirm"
        : "Agent is NOT reconciler — use owner Ledger command; do not agent --invoke",
    };
  }

  if (!agentIsReconciler) {
    return {
      ok: false,
      reason: "agent_not_authorized_reconciler",
      on_chain_reconciler: reconciler,
      owner_reconcile: ownerCmd,
      note: "Do not set_reconciler automatically. Owner/reconciler must sign separately.",
    };
  }

  if (!a?.reconcilePending || !a?.getPending) {
    return { ok: false, reason: "reconcile_adapter_missing" };
  }

  const res = await a.reconcilePending({
    operationId,
    settlementState,
    evidenceHash: hash,
  });
  if (!res.ok) return res;

  const pendingAfter =
    deps.pendingAfter || (await a.getPending(operationId));
  const terminalOk = verifyPendingSettlementTerminal(
    pendingAfter,
    settlementState
  );
  if (!terminalOk.ok) {
    return {
      ok: false,
      reason: terminalOk.reason,
      pending_after: pendingAfter,
      reconcile_tx: res.transaction_hash,
      note: "reconcile_pending submitted but on-chain PendingOp not verified terminal",
    };
  }

  advanceLifecycle(operationId, CANARY_STATES.RECONCILED, {
    env,
    storeDir,
    outcome: {
      near_tx: res.transaction_hash,
      evidence_hash: hash,
      settlement_state: terminalOk.settlement_state,
      verified_onchain: true,
    },
  });

  return {
    ok: true,
    stage: CANARY_STATES.RECONCILED,
    reconcile: res,
    pending_after: pendingAfter,
    mutations_invoked: true,
    note: "On-chain PendingOp settlement_state verified terminal after reconcile_pending",
  };
}

function verifyPendingSettlementTerminal(pending, expectedState) {
  if (!pending) {
    return { ok: false, reason: "pending_missing_after_reconcile" };
  }
  const state = pending.settlement_state || pending.settlementState;
  const normalized = String(state || "");
  const want = String(expectedState || "Success");
  const aliases = {
    Success: ["Success", "SUCCESS"],
    Refunded: ["Refunded", "REFUNDED"],
    Failed: ["Failed", "FAILED"],
    Expired: ["Expired", "EXPIRED"],
    Reconciled: ["Reconciled", "RECONCILED"],
  };
  const okList = aliases[want] || [want];
  if (!okList.includes(normalized)) {
    return {
      ok: false,
      reason: "pending_settlement_not_terminal",
      got: normalized,
      want,
    };
  }
  return { ok: true, settlement_state: normalized };
}

/** Verify get_paused===true after owner pause (read-only). */
export async function canaryStepVerifyPaused({
  adapters = null,
  env = process.env,
  testHarness = false,
  deps = {},
} = {}) {
  let paused;
  if (deps.paused != null) paused = Boolean(deps.paused);
  else {
    const a =
      adapters ||
      (testHarness ? null : await createMainnetCanaryAdapters({ env }));
    if (!a) return { ok: false, reason: "adapters_required" };
    paused = await a.getPaused();
  }
  return {
    ok: paused === true,
    policy_paused_onchain: paused,
    window: windowStatusReport({
      policyPausedOnchain: paused,
      owner_pause_required: paused !== true,
      broadcastStatus: "not_sent",
    }),
  };
}

/**
 * Full dry rehearsal — zero mutations. Used by tests + checkpoint.
 * testHarness allows injected fixtures.
 */
export async function runCanaryDryRehearsal(args = {}) {
  const {
    operationId,
    env = process.env,
    storeDir = null,
    deps = {},
  } = args;

  const prep = await prepareCanaryOperation({
    operationId,
    env,
    storeDir,
  });
  if (!prep.ok) return prep;

  const quote = await canaryStepQuoteAttest({
    operationId: prep.operation_id,
    env,
    storeDir,
    testHarness: true,
    deps,
  });
  if (!quote.ok) return quote;

  const gates = assertMainnetBroadcastAllowed(env);
  const unlock = buildCanaryUnlockContext(prep.operation_id, {
    env,
    storeDir,
    requireQuoteBound: true,
  });

  return {
    ok: true,
    stage: "DRY_REHEARSAL_COMPLETE",
    operation_id: prep.operation_id,
    quote,
    gates_default_locked: gates.ok === false,
    canary_unlock_valid: unlock.ok === true,
    mutations_invoked: false,
    note: "No propose/sign/broadcast. Sequential live steps remain for operator CLI.",
  };
}

/** @deprecated use runCanaryDryRehearsal / step functions */
export async function runCanaryExecutor(args = {}) {
  if (args.executeLive === true && args.dryRun === false) {
    return {
      ok: false,
      reason: "use_sequential_cli_steps_not_monolith",
      note: "J8B-1 forbids single-shot live execution; use operator CLI phases",
    };
  }
  return runCanaryDryRehearsal(args);
}

export {
  verifyBaseUsdcDelta,
  settlementRecoverySteps,
  createMainnetCanaryAdapters,
  CANARY_STATES,
};
