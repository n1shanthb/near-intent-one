/**
 * Gate K execution — reuses Gate I propose_quoted_evm_transfer + request_signature.
 * Does NOT implement a second signing path. Never broadcasts ECDSA here;
 * reconciler owns Sepolia broadcast + settlement.
 */
import {
  CHAIN_ID,
  USDC_SEPOLIA,
  ORIGIN_ASSET,
  DEST_ASSET,
  DEFAULT_GAS_LIMIT,
  DEFAULT_MAX_GAS_PRICE,
  DEMO_PREFIX,
  REASON,
} from "./constants.mjs";

/**
 * Build Tidepool agent request for EXACT_INPUT USDC→wNEAR.
 */
export function buildAgentRequest({ amount, recipient, deadlineMs = 45 * 60 * 1000 }) {
  return {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: ORIGIN_ASSET,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: DEST_ASSET,
    amount: String(amount),
    refundTo: recipient,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + deadlineMs).toISOString(),
  };
}

/**
 * Pre-sign checklist — fail closed on any mismatch.
 */
export function preSignChecks({
  portfolio,
  mandate,
  safeProposal,
  quote,
  economic,
  expectedEpoch,
  currentEpoch,
  reconcilerOk,
  authenticated,
}) {
  const checks = [];
  const push = (name, ok, detail = {}) => checks.push({ name, ok, ...detail });

  if (!authenticated) {
    push("authenticated", false);
    return { ok: false, reason: REASON.UNAUTHENTICATED, checks };
  }
  push("authenticated", true);

  if (!portfolio?.policy_contract || String(portfolio.policy_contract).startsWith(DEMO_PREFIX)) {
    push("demo_isolation", false);
    return { ok: false, reason: "DEMO_PORTFOLIO_FORBIDDEN", checks };
  }
  push("demo_isolation", true);

  if (!mandate || mandate.revoked || mandate.paused) {
    push("mandate_active", false, { revoked: mandate?.revoked, paused: mandate?.paused });
    return {
      ok: false,
      reason: mandate?.revoked ? "MANDATE_REVOKED" : "POLICY_PAUSED",
      checks,
    };
  }
  push("mandate_active", true);

  if (String(mandate.owner_account) !== String(portfolio.owner_account)) {
    push("owner", false);
    return { ok: false, reason: "WRONG_PORTFOLIO_OWNER", checks };
  }
  push("owner", true);

  if (
    expectedEpoch != null &&
    currentEpoch != null &&
    String(expectedEpoch) !== String(currentEpoch)
  ) {
    push("epoch", false, { expectedEpoch, currentEpoch });
    return { ok: false, reason: REASON.POLICY_CHANGED, checks };
  }
  push("epoch", true, { epoch: currentEpoch });

  if (!reconcilerOk) {
    push("reconciler", false);
    return { ok: false, reason: REASON.RECONCILER_DOWN, checks };
  }
  push("reconciler", true);

  if (!quote?.quote_hash || !quote?.amount_out) {
    push("fresh_quote", false);
    return { ok: false, reason: REASON.NO_FRESH_QUOTE, checks };
  }
  push("fresh_quote", true, { quote_hash: quote.quote_hash });

  if (!economic?.ok) {
    push("economics", false, economic);
    return { ok: false, reason: economic?.reason || "ECONOMIC_NOT_VIABLE", checks };
  }
  push("economics", true);

  const amount = String(safeProposal?.proposed_size_usdc_raw || "0");
  if (!amount || amount === "0") {
    push("amount", false);
    return { ok: false, reason: "ZERO_SIZE", checks };
  }
  push("amount", true, { amount });

  return { ok: true, checks, amount };
}

/**
 * Execute Gate I path: attest → propose → request_signature.
 * Leaves status SIGNED_PENDING_BROADCAST for reconciler.
 *
 * @param {object} deps
 * @param {object} deps.store
 * @param {Function} deps.getNearAccounts — ({portfolio}) => { agent }
 * @param {Function} deps.viewFunction
 * @param {object} deps.attestor
 * @param {Function} deps.eth — (method, params) => Promise
 * @param {object} args
 */
export async function executeGateKTrade(deps, args) {
  const { store, getNearAccounts, viewFunction, attestor, eth, logger = console } = deps;
  const {
    portfolioId,
    portfolio,
    mandate,
    safeProposal,
    quote,
    economic,
    agentRequest,
    authenticated,
    reconcilerOk,
    operatorConfirmed,
    mode,
    idempotencyKey,
  } = args;

  if (!operatorConfirmed) {
    return {
      ok: false,
      reason: REASON.OPERATOR_CONFIRM_REQUIRED,
      signed: false,
    };
  }

  const epoch = await viewFunction(portfolio.policy_contract, "get_mandate_epoch");
  const pre = preSignChecks({
    portfolio,
    mandate,
    safeProposal,
    quote,
    economic,
    expectedEpoch: mandate.mandate_epoch ?? mandate.epoch,
    currentEpoch: epoch,
    reconcilerOk,
    authenticated,
  });
  if (!pre.ok) {
    return { ok: false, ...pre, signed: false };
  }

  const amount = pre.amount;
  const evm = portfolio.intents_signer_id;
  if (!evm) {
    return { ok: false, reason: "INTENTS_SIGNER_MISSING", signed: false };
  }

  const execKey =
    idempotencyKey ||
    `gate_k:${portfolioId}:${safeProposal.operation_id || Date.now()}`;

  const existing = store.read().executions?.[execKey];
  if (existing?.status === "SUCCESS" || existing?.status === "SIGNED_PENDING_BROADCAST") {
    return {
      ok: false,
      reason: "IDEMPOTENT_ALREADY_EXECUTED",
      existing,
      signed: existing.status === "SIGNED_PENDING_BROADCAST",
    };
  }

  const inflight = store.beginExecution(execKey, {
    kind: "gate_k_ai_trade",
    portfolio_id: portfolioId,
    mode,
    amount,
    operation_id_hint: safeProposal.operation_id || null,
  });
  if (inflight.status === "SUCCESS") {
    return { ok: false, reason: "IDEMPOTENT_SUCCESS", signed: false };
  }

  try {
    const attest = attestor.attest({
      quoteResponse: quote,
      agentRequest: agentRequest || buildAgentRequest({ amount, recipient: evm }),
      tokenContract: USDC_SEPOLIA,
      chainId: CHAIN_ID,
      maxGasPrice: DEFAULT_MAX_GAS_PRICE.toString(),
      gasLimit: DEFAULT_GAS_LIMIT.toString(),
    });
    if (!attest.ok) {
      store.finishExecution(execKey, {
        status: "FAILED",
        reason: "attestor_rejected",
        checks: attest.checks,
      });
      return { ok: false, reason: "ATTESTOR_REJECTED", checks: attest.checks, signed: false };
    }

    // Re-check epoch immediately before propose (fail closed if changed)
    const epoch2 = await viewFunction(portfolio.policy_contract, "get_mandate_epoch");
    if (String(epoch2) !== String(epoch)) {
      store.finishExecution(execKey, {
        status: "FAILED",
        reason: REASON.POLICY_CHANGED,
      });
      return { ok: false, reason: REASON.POLICY_CHANGED, signed: false };
    }

    const nonceObserved = BigInt(
      (await eth("eth_getTransactionCount", [evm, "pending"])).result
    );
    const nonce = BigInt(store.nextNonce(evm, nonceObserved.toString())) - 1n;
    let gasPrice = BigInt((await eth("eth_gasPrice", [])).result || "0");
    if (gasPrice < 1_000_000_000n) gasPrice = 1_000_000_000n;
    gasPrice = (gasPrice * 120n) / 100n;
    if (gasPrice > DEFAULT_MAX_GAS_PRICE) gasPrice = DEFAULT_MAX_GAS_PRICE;

    const opId = `k-ai-${Date.now()}`;
    const { agent } = await getNearAccounts(portfolio);

    const propose = await agent.functionCall({
      contractId: portfolio.policy_contract,
      methodName: "propose_quoted_evm_transfer",
      args: {
        operation_id: opId,
        attestation: attest.attestation,
        attestation_signature: attest.signature,
        signer_public_key: attest.publicKey,
        tx: {
          nonce: nonce.toString(),
          gas_price: gasPrice.toString(),
          gas_limit: DEFAULT_GAS_LIMIT.toString(),
          chain_id: String(CHAIN_ID),
          token_contract: USDC_SEPOLIA.toLowerCase(),
          to: attest.attestation.deposit_address,
          amount,
        },
        expected_epoch: epoch,
      },
      gas: BigInt("100000000000000"),
      attachedDeposit: 0n,
    });

    const sign = await agent.functionCall({
      contractId: portfolio.policy_contract,
      methodName: "request_signature",
      args: { operation_id: opId },
      gas: BigInt("300000000000000"),
      attachedDeposit: 1n,
    });

    const result = {
      status: "SIGNED_PENDING_BROADCAST",
      kind: "gate_k_ai_trade",
      portfolio_id: portfolioId,
      operation_id: opId,
      amount,
      nonce: nonce.toString(),
      gas_price: gasPrice.toString(),
      chain_id: CHAIN_ID,
      token_contract: USDC_SEPOLIA.toLowerCase(),
      to: attest.attestation.deposit_address,
      propose_tx: propose.transaction.hash,
      sign_tx: sign.transaction.hash,
      quote_hash: quote.quote_hash,
      mode,
      note: "ECDSA exported — not revocable; reconciler must finish honestly",
    };

    store.finishExecution(execKey, result);
    store.upsertPortfolio(portfolioId, {
      last_settlement: {
        operation_id: opId,
        status: "SIGNED_PENDING_BROADCAST",
        near_tx: sign.transaction.hash,
        source: "gate_k",
      },
    });

    logger.info?.(
      `[gate-k] signed op=${opId} near=${sign.transaction.hash} amount=${amount}`
    );

    return {
      ok: true,
      signed: true,
      execution: result,
      exec_key: execKey,
      preview: {
        max_spend_usdc_raw: amount,
        chain_id: CHAIN_ID,
        token: USDC_SEPOLIA,
        recipient: attest.attestation.deposit_address,
        nonce: nonce.toString(),
      },
    };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 500);
    store.finishExecution(execKey, { status: "FAILED", reason: msg });
    logger.error?.(`[gate-k] execute failed: ${msg}`);
    return { ok: false, reason: "EXECUTE_FAILED", error: msg, signed: false };
  }
}

/**
 * Build a transaction preview without signing (for operator confirmation).
 */
export function buildExecutionPreview({
  portfolio,
  mandate,
  safeProposal,
  quote,
  economic,
  mode,
}) {
  const amount = String(safeProposal?.proposed_size_usdc_raw || "0");
  return {
    mode,
    portfolio_id: portfolio?.portfolio_id || portfolio?.id,
    owner_account: mandate?.owner_account,
    policy_contract: portfolio?.policy_contract,
    mandate_epoch: mandate?.mandate_epoch ?? mandate?.epoch,
    policy_hash: mandate?.policy_hash,
    autonomous_trading: mandate?.autonomous_trading === true,
    pair: safeProposal?.pair,
    network: safeProposal?.network,
    amount_usdc_raw: amount,
    amount_usdc: (Number(amount) / 1e6).toFixed(6),
    max_spend_usdc: (Number(amount) / 1e6).toFixed(6),
    quote_hash: quote?.quote_hash || null,
    amount_out: quote?.amount_out || null,
    economics: economic || null,
    chain_id: CHAIN_ID,
    token_contract: USDC_SEPOLIA,
    origin_asset: ORIGIN_ASSET,
    destination_asset: DEST_ASSET,
    intents_signer_id: portfolio?.intents_signer_id || null,
    signing: "NEAR MPC via propose_quoted_evm_transfer → request_signature",
    broadcast: "reconciler (not this step)",
    warning:
      "STOP — no broadcast until operator explicitly authorizes first live test",
  };
}
