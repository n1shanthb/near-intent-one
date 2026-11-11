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
import { SEPOLIA_TIDEPOOL, assertProfileIsolation } from "../execution/chainProfiles.mjs";

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
  /** Live Sepolia ETH balance (wei string/bigint) for gas floor. */
  eth_balance_wei = null,
  gas_price = null,
  gas_limit = DEFAULT_GAS_LIMIT,
  /** Live USDC balance (raw 6-dec string/bigint) immediately before sign. */
  usdc_balance_raw = null,
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

  if (mandate.signing_revoked) {
    push("signing_revoked", false);
    return { ok: false, reason: REASON.SIGNING_REVOKED, checks };
  }
  push("signing_revoked", true);

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

  if (usdc_balance_raw != null) {
    try {
      if (BigInt(usdc_balance_raw) < BigInt(amount)) {
        push("usdc_balance", false, { usdc_balance_raw, amount });
        return { ok: false, reason: REASON.INSUFFICIENT_BALANCE, checks };
      }
      push("usdc_balance", true);
    } catch {
      push("usdc_balance", false);
      return { ok: false, reason: REASON.INSUFFICIENT_BALANCE, checks };
    }
  }

  if (eth_balance_wei != null && gas_price != null) {
    try {
      const need = BigInt(gas_price) * BigInt(gas_limit);
      if (BigInt(eth_balance_wei) < need) {
        push("eth_gas", false, {
          eth_balance_wei: String(eth_balance_wei),
          need: need.toString(),
        });
        return { ok: false, reason: REASON.INSUFFICIENT_GAS, checks };
      }
      push("eth_gas", true, { need: need.toString() });
    } catch {
      push("eth_gas", false);
      return { ok: false, reason: REASON.INSUFFICIENT_GAS, checks };
    }
  }

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
  const {
    store,
    getNearAccounts,
    viewFunction,
    attestor,
    eth,
    logger = console,
    journal: depsJournal = null,
    profile: depsProfile = null,
  } = deps;
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
    ownerSessionId = null,
    journal: argsJournal = null,
    profile: argsProfile = null,
  } = args;

  if (!operatorConfirmed) {
    return {
      ok: false,
      reason: REASON.OPERATOR_CONFIRM_REQUIRED,
      signed: false,
    };
  }

  const epoch = await viewFunction(portfolio.policy_contract, "get_mandate_epoch");
  const evm = portfolio.intents_signer_id;
  if (!evm) {
    return { ok: false, reason: "INTENTS_SIGNER_MISSING", signed: false };
  }

  let eth_balance_wei = null;
  let usdc_balance_raw = null;
  let gas_price = null;
  try {
    const [ethBal, gasPriceHex] = await Promise.all([
      eth("eth_getBalance", [evm, "latest"]),
      eth("eth_gasPrice", []),
    ]);
    eth_balance_wei = BigInt(ethBal?.result || "0x0");
    gas_price = BigInt(gasPriceHex?.result || "0x0");
    if (gas_price < 1_000_000_000n) gas_price = 1_000_000_000n;
    if (gas_price > DEFAULT_MAX_GAS_PRICE) gas_price = DEFAULT_MAX_GAS_PRICE;
  } catch {
    eth_balance_wei = null;
    gas_price = null;
  }
  try {
    // ERC-20 balanceOf(address) selector 0x70a08231
    const data =
      "0x70a08231000000000000000000000000" +
      String(evm).replace(/^0x/, "").toLowerCase().padStart(40, "0");
    const bal = await eth("eth_call", [
      { to: USDC_SEPOLIA, data },
      "latest",
    ]);
    usdc_balance_raw = BigInt(bal?.result || "0x0");
  } catch {
    usdc_balance_raw = null;
  }

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
    eth_balance_wei,
    gas_price,
    gas_limit: DEFAULT_GAS_LIMIT,
    usdc_balance_raw,
  });
  if (!pre.ok) {
    return { ok: false, ...pre, signed: false };
  }

  const amount = pre.amount;
  const profile = argsProfile || depsProfile || SEPOLIA_TIDEPOOL;
  const journal = argsJournal || depsJournal || null;
  try {
    assertProfileIsolation(profile, {
      chainId: CHAIN_ID,
      token: USDC_SEPOLIA,
      originAsset: ORIGIN_ASSET,
      settleBase: profile.settle_api_base,
    });
  } catch (e) {
    return { ok: false, reason: String(e.message || e), signed: false };
  }
  if (profile.network === "mainnet" && !journal) {
    return { ok: false, reason: "journal_required_for_mainnet_funded", signed: false };
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
      may_resign: false,
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

  // Journal DRAFT before any MPC sign — crash here ⇒ no signature, no broadcast.
  const journalId = `j:${execKey}`;
  if (journal) {
    try {
      journal.assertWritable();
      journal.insertDraft({
        id: journalId,
        portfolio_id: portfolioId,
        idempotency_key: execKey,
        chain_id: String(CHAIN_ID),
        meta: {
          owner_account: portfolio.owner_account,
          policy_epoch: epoch,
          quote_hash: quote.quote_hash,
          profile: profile.id,
          mode,
        },
      });
    } catch (e) {
      store.finishExecution(execKey, {
        status: "FAILED",
        reason: "journal_unavailable",
      });
      return {
        ok: false,
        reason: "journal_unavailable",
        error: String(e.message || e).slice(0, 200),
        signed: false,
      };
    }
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
      lifecycle: "MPC_SIGNED",
      kind: "gate_k_ai_trade",
      portfolio_id: portfolioId,
      operation_id: opId,
      amount,
      nonce: nonce.toString(),
      gas_price: gasPrice.toString(),
      gas_limit: DEFAULT_GAS_LIMIT.toString(),
      chain_id: CHAIN_ID,
      token_contract: USDC_SEPOLIA.toLowerCase(),
      to: attest.attestation.deposit_address,
      propose_tx: propose.transaction.hash,
      sign_tx: sign.transaction.hash,
      quote_hash: quote.quote_hash,
      policy_epoch: epoch,
      journal_id: journalId,
      profile: profile.id,
      mode,
      owner_account: portfolio.owner_account || null,
      owner_session_id: ownerSessionId || null,
      may_resign: false,
      note: "MPC_SIGNED / ECDSA exported — NOT settled; settlement worker must broadcast+reconcile without re-signing",
    };

    if (journal) {
      const row = journal.get(journalId);
      if (row) {
        journal.db
          .prepare(
            `UPDATE tx_journal SET nonce = ?, meta_json = ?, updated_at = ? WHERE id = ?`
          )
          .run(
            nonce.toString(),
            JSON.stringify({
              ...JSON.parse(row.meta_json || "{}"),
              operation_id: opId,
              sign_tx: sign.transaction.hash,
              propose_tx: propose.transaction.hash,
              to: attest.attestation.deposit_address,
              amount,
              token: USDC_SEPOLIA.toLowerCase(),
              mpc_signed: true,
              // Signed raw EVM bytes are assembled at broadcast from MPC sig;
              // journal remains DRAFT until settle persists exact bytes pre-broadcast.
            }),
            new Date().toISOString(),
            journalId
          );
      }
    }

    store.finishExecution(execKey, result);
    store.upsertPortfolio(portfolioId, {
      last_settlement: {
        operation_id: opId,
        status: "SIGNED_PENDING_BROADCAST",
        lifecycle: "MPC_SIGNED",
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
