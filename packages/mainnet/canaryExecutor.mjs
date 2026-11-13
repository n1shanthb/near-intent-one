/**
 * J8B-0 — one-shot mainnet canary executor (DISABLED by default).
 *
 * Dry-run (default): builds quote→attest→propose args→digest→journal plan.
 * Live mutations require: valid one-shot approval + per-phase operator confirms +
 * executeLive=true. Autonomous ticks NEVER call this.
 *
 * NO mock success in production path — adapters must be real when executeLive.
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
  recordOperatorConfirmation,
  requireOperatorConfirmation,
  consumeCanaryApproval,
  buildCanaryUnlockContext,
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
} from "./safetyGates.mjs";
import { productionDryQuote } from "./intents.mjs";
import {
  attestTidepoolQuote,
  publicKeyEd25519,
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
  serializeSignedTx,
} from "../intents-codec/quote-auth.mjs";
import {
  evaluateLiveMinOutAgainstPolicy,
  buildErc20TxParams,
  simulatePolicyChecks,
} from "./quotePath.mjs";
import { MAINNET_IDENTITIES, MAINNET_EVM_RPCS } from "./identities.mjs";
import { chooseGasParams } from "./j8a.preflight.mjs";
import {
  estimateErc20TransferGas,
  fetchArbitrumGasPrice,
} from "./arbitrumFunding.mjs";
import { evmNativeBalance, evmErc20Balance } from "./evmBalances.mjs";
import { MAINNET_1CLICK } from "../execution/chainProfiles.mjs";
import { broadcastWithJournal } from "../execution/durableBroadcast.mjs";
import {
  verifySourceUsdcTransfer,
  monitorOneClickByDeposit,
  verifyBaseUsdcDelta,
  settlementRecoverySteps,
} from "./canarySettlement.mjs";
import {
  extractMpcSigFromNearTx,
  mpcToRsV,
  recoverFromHash,
} from "../gate-k/settle.mjs";

function loadAttestor(env = process.env) {
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

async function ethRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

function failClose(state, reason, extra = {}) {
  return {
    ok: false,
    reason,
    execute_live: false,
    window_closed: true,
    ...state,
    ...extra,
  };
}

/**
 * Prepare a canary operation (approval + dry wiring). Never mutates chain.
 */
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
    stage: "approval_created",
    operation_id: created.operation_id,
    fingerprint: created.fingerprint,
    expires_at: created.expires_at,
    path: created.path,
    gates_default: gates,
    note: "Approval created; quote bind + operator confirms still required before any mutation",
    mutations: noneMutations(),
  };
}

function noneMutations() {
  return {
    unpause: false,
    propose_quoted_evm_transfer: false,
    request_signature: false,
    eth_sendRawTransaction: false,
    pause: false,
    escrow_transfer: false,
  };
}

/**
 * Run canary pipeline.
 * @param {object} args
 * @param {boolean} [args.executeLive=false] — must stay false in J8B-0
 * @param {object} [args.operatorConfirms] — { quote, propose, sign, broadcast }
 * @param {object} [args.deps] — injectable adapters for tests
 */
export async function runCanaryExecutor(args = {}) {
  const {
    operationId,
    executeLive = false,
    dryRun = true,
    storeDir = null,
    env = process.env,
    operatorConfirms = {},
    deps = {},
  } = args;

  const live = executeLive === true && dryRun === false;
  const mutations = noneMutations();
  const audit = [];
  const push = (event, detail = {}) =>
    audit.push({ at: new Date().toISOString(), event, ...detail });

  // Global defaults must remain locked
  const gates = mainnetExecutionGates(env);
  if (gates.autonomous_execution_enabled) {
    return failClose({ audit, mutations }, "autonomous_forbidden");
  }

  let unlock = validateCanaryApproval(operationId, {
    env,
    storeDir,
    requireQuoteBound: false,
  });
  if (!unlock.ok) return failClose({ audit, mutations }, unlock.reason);

  // --- balances / nonce / gas ---
  const arbRpc = deps.arbRpc || MAINNET_EVM_RPCS.arbitrum;
  const mpc = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
  const ethBal =
    deps.ethBal || (await evmNativeBalance(arbRpc, mpc));
  const usdcBal =
    deps.usdcBal || (await evmErc20Balance(arbRpc, CANARY_TOKEN, mpc));
  const nonceJ =
    deps.nonce != null
      ? { result: "0x" + Number(deps.nonce).toString(16) }
      : await ethRpc(arbRpc, "eth_getTransactionCount", [mpc, "pending"]);
  const nonce = Number(BigInt(nonceJ.result || "0x0"));
  const gasPriceJ = deps.gasPrice || (await fetchArbitrumGasPrice(arbRpc));

  if (!ethBal.ok || !usdcBal.ok || BigInt(usdcBal.raw) < BigInt(CANARY_AMOUNT)) {
    return failClose(
      { audit, mutations, balances: { ethBal, usdcBal } },
      "insufficient_balances"
    );
  }

  // --- quote ---
  if (operatorConfirms.quote) {
    recordOperatorConfirmation(operationId, "quote", {
      env,
      storeDir,
      confirmed: true,
    });
  }
  const confQuote = requireOperatorConfirmation(
    validateCanaryApproval(operationId, { env, storeDir }).record,
    "quote"
  );
  // In dry prepare without confirms, allow quote fetch for wiring tests when allowUnauthedQuoteProbe
  const mayQuote =
    confQuote.ok || args.allowProbeWithoutConfirm === true || !live;

  if (!mayQuote && live) {
    return failClose({ audit, mutations }, confQuote.reason);
  }

  push("quote_start");
  let quoteResult = deps.quoteResult;
  if (!quoteResult) {
    const prev = env.NIO_MAINNET_ALLOW_FUNDED_QUOTE;
    env.NIO_MAINNET_ALLOW_FUNDED_QUOTE = "1";
    try {
      quoteResult = await (deps.quoteFn || productionDryQuote)(
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
    return failClose(
      { audit, mutations, quote: quoteResult },
      "quote_verify_failed"
    );
  }

  const limits = deps.limits || {
    max_slippage_bps: 100,
    max_trade_value: "5000000",
    max_gas_budget: "2500000000000000",
    max_pending_exposure: "10000000",
    allowed_assets: [CANARY_ASSET_IN, CANARY_ASSET_OUT],
    allowed_destinations: [mpc, MAINNET_IDENTITIES.owner],
    allowed_chains: ["eip155:42161", "eip155:8453", "near", "eip155:1"],
    allowed_venues: ["near_intents_1click"],
    token_scope: "allowlist",
  };

  const floor = evaluateLiveMinOutAgainstPolicy({
    amountIn: quoteResult.amount_in,
    minAmountOut: quoteResult.min_amount_out,
    maxSlippageBps: limits.max_slippage_bps,
    label: "canary",
  });
  if (floor.result !== "PASS") {
    return failClose({ audit, mutations, floor }, "policy_floor_blocked");
  }

  bindQuoteToApproval(operationId, {
    quoteHash: quoteResult.one_click_verify.quote_hash,
    depositAddress: quoteResult.deposit_address,
    env,
    storeDir,
  });
  push("quote_bound", {
    quote_hash: quoteResult.one_click_verify.quote_hash,
    deposit: quoteResult.deposit_address,
  });

  // --- gas ---
  const gasEst =
    deps.gasEst ||
    (await estimateErc20TransferGas(arbRpc, {
      from: mpc,
      token: CANARY_TOKEN,
      to: quoteResult.deposit_address,
      amountRaw: CANARY_AMOUNT,
    }));
  if (!gasEst.ok || !gasPriceJ.ok) {
    return failClose({ audit, mutations }, "gas_estimate_failed");
  }
  const gasParams = chooseGasParams({
    liveGasPriceWei: gasPriceJ.wei,
    estimatedGas: gasEst.gas,
    ethBalanceWei: ethBal.wei,
  });
  if (!gasParams.ok) {
    return failClose({ audit, mutations, gasParams }, "gas_params_blocked");
  }

  // --- attest ---
  const attestor = deps.attestor || loadAttestor(env);
  const attestResult =
    deps.attestResult ||
    attestTidepoolQuote({
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

  if (!attestResult.ok) {
    return failClose(
      { audit, mutations, attest: attestResult },
      "attestation_failed"
    );
  }

  let localSigOk = false;
  try {
    const sigBody = attestResult.signature.replace(/^ed25519:/, "");
    localSigOk = nacl.sign.detached.verify(
      Buffer.from(attestResult.message_utf8, "utf8"),
      bs58.decode(sigBody),
      nacl.sign.keyPair.fromSecretKey(attestor.secretKey64).publicKey
    );
  } catch {
    localSigOk = false;
  }
  if (!localSigOk) {
    return failClose({ audit, mutations }, "attestation_sig_invalid");
  }

  const policyTx = buildErc20TxParams({
    depositAddress: attestResult.attestation.deposit_address,
    tokenContract: attestResult.attestation.token_contract,
    amountIn: attestResult.attestation.amount_in,
    chainId: CANARY_CHAIN_ID,
    nonce,
    gasPrice: gasParams.gas_price,
    gasLimit: gasParams.gas_limit,
  });

  // Binding checks
  if (policyTx.to !== String(quoteResult.deposit_address).toLowerCase()) {
    return failClose({ audit, mutations }, "wrong_escrow");
  }
  if (policyTx.token_contract !== CANARY_TOKEN) {
    return failClose({ audit, mutations }, "wrong_token");
  }
  if (String(policyTx.amount) !== CANARY_AMOUNT) {
    return failClose({ audit, mutations }, "wrong_amount");
  }
  if (Number(policyTx.nonce) !== nonce) {
    return failClose({ audit, mutations }, "wrong_nonce");
  }
  if (BigInt(policyTx.gas_price) > BigInt(gasParams.max_gas_price)) {
    return failClose({ audit, mutations }, "wrong_gas_price");
  }

  const data = erc20TransferData(
    attestResult.attestation.deposit_address,
    CANARY_AMOUNT
  );
  const digest = digestHex(
    eip155UnsignedDigest({
      nonce,
      gasPrice: BigInt(gasParams.gas_price),
      gasLimit: BigInt(gasParams.gas_limit),
      to: CANARY_TOKEN,
      data,
      chainId: CANARY_CHAIN_ID,
    })
  );
  if (digest !== policyTx.digest_hex) {
    return failClose({ audit, mutations }, "digest_mismatch");
  }

  const policySim = simulatePolicyChecks({
    attestation: attestResult.attestation,
    tx: policyTx,
    expectedEpoch: 2,
    mandateEpoch: 2,
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
    return failClose(
      { audit, mutations, policySim },
      "policy_sim_failed"
    );
  }

  const proposeArgs = {
    operation_id: operationId,
    attestation: attestResult.attestation,
    attestation_signature: attestResult.signature,
    signer_public_key: CANARY_ATTESTOR_PK,
    tx: {
      nonce: String(nonce),
      gas_price: gasParams.gas_price,
      gas_limit: gasParams.gas_limit,
      chain_id: String(CANARY_CHAIN_ID),
      token_contract: CANARY_TOKEN,
      to: attestResult.attestation.deposit_address,
      amount: CANARY_AMOUNT,
    },
    expected_epoch: 2,
  };

  const plan = {
    propose: {
      contract: MAINNET_IDENTITIES.policy,
      method: "propose_quoted_evm_transfer",
      args: proposeArgs,
      signer: MAINNET_IDENTITIES.agent,
    },
    request_signature: {
      contract: MAINNET_IDENTITIES.policy,
      method: "request_signature",
      args: { operation_id: operationId },
      attached_deposit: "1 yoctoNEAR",
      signer: MAINNET_IDENTITIES.agent,
    },
    eip155: {
      to: CANARY_TOKEN,
      data_hex: "0x" + Buffer.from(data).toString("hex"),
      digest_hex: digest,
      nonce,
      gas_price: gasParams.gas_price,
      gas_limit: gasParams.gas_limit,
      chain_id: CANARY_CHAIN_ID,
      transfer_to: attestResult.attestation.deposit_address,
      amount: CANARY_AMOUNT,
    },
    mpc: {
      path: MAINNET_IDENTITIES.derivation_path,
      predecessor: MAINNET_IDENTITIES.policy,
      expected_evm: mpc,
    },
  };

  push("plan_ready", { digest });

  // --- live mutations only if executeLive ---
  if (!live) {
    // Prove broadcast gate still closed without unlocking for random submit
    const blocked = assertMainnetBroadcastAllowed(env);
    const canaryUnlock = buildCanaryUnlockContext(operationId, {
      env,
      storeDir,
      requireQuoteBound: true,
    });
    return {
      ok: true,
      stage: "DRY_READY",
      execute_live: false,
      operation_id: operationId,
      quote: {
        ok: true,
        quote_hash: quoteResult.one_click_verify.quote_hash,
        deposit_address: quoteResult.deposit_address,
        min_amount_out: quoteResult.min_amount_out,
        amount_out: quoteResult.amount_out,
      },
      attestation: {
        ok: true,
        attestation_id: attestResult.attestation_id,
        publicKey: attestResult.publicKey,
      },
      gas: gasParams,
      policy_sim: policySim,
      plan,
      digest_hex: digest,
      mutations,
      audit,
      gates_default_locked: blocked.ok === false,
      canary_unlock_valid: canaryUnlock.ok === true,
      note: "J8B-0 dry wiring complete — no propose/sign/broadcast",
      settlement_recovery: settlementRecoverySteps("PENDING"),
    };
  }

  // ===== LIVE PATH (for J8B later; still requires confirms) =====
  for (const phase of ["propose", "sign", "broadcast"]) {
    if (operatorConfirms[phase]) {
      recordOperatorConfirmation(operationId, phase, {
        env,
        storeDir,
        confirmed: true,
      });
    }
    const rec = validateCanaryApproval(operationId, {
      env,
      storeDir,
      requireQuoteBound: true,
    });
    const need = requireOperatorConfirmation(rec.record, phase);
    if (!need.ok) {
      consumeCanaryApproval(operationId, {
        env,
        storeDir,
        reason: `fail_close_${need.reason}`,
      });
      return failClose({ audit, mutations, plan }, need.reason);
    }
  }

  const canaryUnlock = buildCanaryUnlockContext(operationId, {
    env,
    storeDir,
    requireQuoteBound: true,
  });
  if (!canaryUnlock.ok) {
    return failClose({ audit, mutations }, canaryUnlock.reason);
  }

  if (!deps.nearPropose || !deps.nearRequestSignature) {
    consumeCanaryApproval(operationId, {
      env,
      storeDir,
      reason: "missing_near_adapters",
    });
    return failClose({ audit, mutations }, "near_adapters_required_for_live");
  }

  // A3 propose
  const proposeRes = await deps.nearPropose(proposeArgs);
  mutations.propose_quoted_evm_transfer = true;
  push("propose_submitted", { result: Boolean(proposeRes) });
  if (proposeRes?.ok === false) {
    consumeCanaryApproval(operationId, {
      env,
      storeDir,
      reason: "propose_failed",
    });
    return failClose({ audit, mutations }, "propose_failed", { proposeRes });
  }

  // On-chain commitment check if provided
  if (deps.getPending) {
    const pending = await deps.getPending(operationId);
    if (
      pending?.payload_commitment &&
      String(pending.payload_commitment).toLowerCase() !== digest.toLowerCase()
    ) {
      consumeCanaryApproval(operationId, {
        env,
        storeDir,
        reason: "payload_commitment_mismatch",
      });
      return failClose({ audit, mutations }, "payload_commitment_mismatch");
    }
  }

  // A4 request_signature
  const signRes = await deps.nearRequestSignature({
    operation_id: operationId,
  });
  mutations.request_signature = true;
  push("request_signature_submitted");
  if (signRes?.ok === false) {
    consumeCanaryApproval(operationId, {
      env,
      storeDir,
      reason: "request_signature_failed",
    });
    return failClose({ audit, mutations }, "request_signature_failed", {
      signRes,
    });
  }

  // Assemble from MPC sig
  let rawHex = deps.signedRawHex || null;
  if (!rawHex && deps.nearTxStatus) {
    const full = await deps.nearTxStatus(signRes);
    const extracted = extractMpcSigFromNearTx(full);
    if (!extracted.found) {
      return failClose(
        { audit, mutations, residual: "mpc_signed_bytes_pending_reconcile" },
        "MPC_SIG_NOT_FOUND"
      );
    }
    let { r, s, recoveryId } = mpcToRsV(extracted.signature_json);
    const digestBytes = Buffer.from(digest, "hex");
    let recovered = recoverFromHash(digestBytes, r, s, recoveryId);
    if (recovered.toLowerCase() !== mpc) {
      const alt = recoveryId ^ 1;
      if (recoverFromHash(digestBytes, r, s, alt).toLowerCase() === mpc) {
        recoveryId = alt;
        recovered = mpc;
      }
    }
    if (recovered.toLowerCase() !== mpc) {
      consumeCanaryApproval(operationId, {
        env,
        storeDir,
        reason: "recovered_address_mismatch",
      });
      return failClose({ audit, mutations }, "recovered_address_mismatch", {
        recovered,
        expected: mpc,
      });
    }
    rawHex = serializeSignedTx({
      nonce,
      gasPrice: BigInt(gasParams.gas_price),
      gasLimit: BigInt(gasParams.gas_limit),
      to: CANARY_TOKEN,
      data,
      chainId: CANARY_CHAIN_ID,
      r,
      s,
      recoveryId,
    });
  }
  if (!rawHex) {
    return failClose(
      { audit, mutations, residual: "signed_raw_missing" },
      "signed_raw_missing"
    );
  }

  if (!deps.journal) {
    return failClose({ audit, mutations }, "journal_required");
  }

  // A5 journal-backed broadcast
  const broadcast = await broadcastWithJournal({
    journal: deps.journal,
    journalId: operationId,
    signedRawHex: rawHex,
    profile: MAINNET_1CLICK,
    eth: deps.eth || ((method, params) => ethRpc(arbRpc, method, params)),
    opts: {
      dryRun: false,
      canaryUnlock,
      operationId,
      storeDir,
      env,
      depositBound: {
        deposit_address: quoteResult.deposit_address,
        binding_ok: true,
      },
      token: CANARY_TOKEN,
      chainId: CANARY_CHAIN_ID,
    },
  });
  if (broadcast.ok && broadcast.broadcast_hash) {
    mutations.eth_sendRawTransaction = true;
  }
  push("broadcast_result", {
    ok: broadcast.ok,
    hash: broadcast.broadcast_hash || null,
    reason: broadcast.reason || null,
  });

  if (!broadcast.ok) {
    // Retain durable state — do not auto-retry / resign
    return {
      ok: false,
      reason: broadcast.reason || "broadcast_failed",
      residual_risk: true,
      may_resign: false,
      mutations,
      audit,
      broadcast,
      settlement_recovery: settlementRecoverySteps("UNKNOWN"),
    };
  }

  const source = await verifySourceUsdcTransfer({
    txHash: broadcast.broadcast_hash,
    mpc,
    escrow: quoteResult.deposit_address,
    amount: CANARY_AMOUNT,
    rpcUrl: arbRpc,
  });
  const settle = await monitorOneClickByDeposit({
    depositAddress: quoteResult.deposit_address,
    maxPolls: deps.settlePolls || 1,
    pollFn: deps.oneClickStatus,
  });

  consumeCanaryApproval(operationId, {
    env,
    storeDir,
    reason: settle.ok ? "success" : "settlement_incomplete_or_failed",
  });

  return {
    ok: source.ok && settle.ok,
    stage: settle.ok ? "SETTLED" : "BROADCAST_PENDING_SETTLEMENT",
    execute_live: true,
    operation_id: operationId,
    mutations,
    audit,
    broadcast,
    source,
    settlement: settle,
    settlement_recovery: settlementRecoverySteps(settle.normalized),
    note: "Policy SUCCESS only after complete settlement evidence",
  };
}

export { verifyBaseUsdcDelta, settlementRecoverySteps };
