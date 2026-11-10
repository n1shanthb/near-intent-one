#!/usr/bin/env node
/**
 * Gate K — first authorized AI-directed Sepolia trade (≤26 USDC on i-a-a4e7).
 *
 * Requires explicit operator authorization (this script is that path).
 * Uses live OpenRouter → Gate K safety → Gate I attest/propose/MPC →
 * Sepolia broadcast → Tidepool → independent reconcile.
 *
 * With --acceptance / GATE_K_ACCEPTANCE=1 (operator-approved Gate K acceptance):
 * if live Strategist proposes TRADE but fitter/critic/economics block, still execute
 * one ≤26 USDC trade after mandate + safety + fresh Tidepool quote checks.
 * Records the override honestly in evidence. Autonomous mode stays OFF.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hexToBytes } from "@noble/curves/abstract/utils";
import {
  serializeSignedTx,
  erc20TransferData,
  eip155UnsignedDigest,
} from "../packages/intents-codec/quote-auth.mjs";
import { evmAddressFromPubkey } from "../packages/intents-codec/eip191.mjs";
import { loadServicesEnv, resetSpendState, getLlmConfig } from "../packages/gate-j/llm.mjs";
import { hydrateMandateFromChain, revalidateMandate } from "../packages/gate-j/hydrate.mjs";
import { verifyPortfolioBalances } from "../packages/gate-j/balances.mjs";
import { verifyBeforeReconcile } from "../packages/reconcile/verify-settlement.mjs";
import { createAttestorService } from "../packages/services/attestor.mjs";
import { openStore } from "../packages/services/store.mjs";
import {
  runGateKPipeline,
  MODE,
  FIRST_TEST,
  buildAgentRequest,
  executeGateKTrade,
  applyGateKSafety,
  fetchFreshExecutableQuote,
  DEFAULT_GAS_LIMIT,
  CHAIN_ID,
  USDC_SEPOLIA,
} from "../packages/gate-k/index.mjs";
import {
  assertNotDemo,
  connectWithAccounts,
  eth,
  ethBalance,
  erc20Balance,
  intentsMtBalance,
  pickRpc,
  viewFunction,
  nearRpc,
  TIDEPOOL,
  ORIGIN_ASSET,
  DEST_ASSET,
} from "./lib/near-live.mjs";

loadServicesEnv();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "evidence", "live");
const DATA = process.env.GATE_I_DATA_DIR || join(ROOT, ".gate-i-data");
mkdirSync(EVIDENCE, { recursive: true });
mkdirSync(DATA, { recursive: true });

const GAS_LIMIT = DEFAULT_GAS_LIMIT;
const ACCEPTANCE =
  process.argv.includes("--acceptance") ||
  process.env.GATE_K_ACCEPTANCE === "1";

function save(name, obj) {
  const p = join(EVIDENCE, name);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  console.error("wrote", name);
  return p;
}

async function waitReceipt(tx, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const j = await eth("eth_getTransactionReceipt", [tx]);
    if (j.result) return j.result;
  }
  return null;
}

function extractSig(fullTx) {
  const out = { found: false };
  for (const r of fullTx?.result?.receipts_outcome || []) {
    const sv = r?.outcome?.status?.SuccessValue;
    if (!sv) continue;
    try {
      const decoded = Buffer.from(sv, "base64").toString("utf8");
      if (decoded.includes("Secp256k1") || decoded.includes("big_r")) {
        out.found = true;
        out.signature_json = JSON.parse(decoded);
      }
    } catch {
      /* */
    }
  }
  return out;
}

function mpcToRsV(sig) {
  const rPoint = hexToBytes(sig.big_r.affine_point);
  const r = rPoint.slice(1);
  const s = hexToBytes(sig.s.scalar);
  let recoveryId = Number(sig.recovery_id);
  if (recoveryId === 27 || recoveryId === 28) recoveryId -= 27;
  return { r, s, recoveryId };
}

function recoverFromHash(hash, r, s, recoveryId) {
  const compact = new Uint8Array(64);
  compact.set(r, 0);
  compact.set(s, 32);
  const pub = secp256k1.Signature.fromCompact(compact)
    .addRecoveryBit(recoveryId)
    .recoverPublicKey(hash);
  return evmAddressFromPubkey(pub.toRawBytes(false));
}

async function main() {
  const out = {
    gate: "K",
    mode: MODE.TESTNET_EXECUTION,
    authorized_at: new Date().toISOString(),
    portfolio_id: FIRST_TEST.portfolio_id,
    max_spend_usdc: FIRST_TEST.max_trade_usdc,
    network: "sepolia_testnet_only",
    pass: false,
    steps: {},
  };

  // Hard gate: only with explicit env from this authorized run
  process.env.GATE_K_ALLOW_SIGN = "1";

  const llm = getLlmConfig();
  out.steps.llm = {
    configured: llm.configured,
    provider: llm.provider,
    models: llm.models,
  };
  if (!llm.configured || llm.provider !== "openrouter") {
    out.reason = "OPENROUTER_REQUIRED";
    save("gate-k-first-trade.json", out);
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }
  resetSpendState();

  const store = openStore(DATA);
  let portfolio = store.getPortfolio(FIRST_TEST.portfolio_id);
  if (!portfolio) {
    const provision = JSON.parse(
      readFileSync(join(EVIDENCE, "gate-i-provision.json"), "utf8")
    );
    const u = (provision.users || []).find(
      (x) => x.portfolio_id === FIRST_TEST.portfolio_id
    );
    if (!u) {
      out.reason = "portfolio_missing";
      save("gate-k-first-trade.json", out);
      process.exit(1);
    }
    portfolio = {
      portfolio_id: u.portfolio_id,
      owner_account: u.owner,
      policy_contract: u.policy,
      agent_account: u.agent,
      reconciler_account: u.reconciler,
      intents_signer_id: u.evm,
      derivation_path: u.derivation_path,
    };
    store.upsertPortfolio(FIRST_TEST.portfolio_id, portfolio);
  }

  assertNotDemo(portfolio.owner_account);
  assertNotDemo(portfolio.policy_contract);
  assertNotDemo(portfolio.agent_account);

  const rpc = await pickRpc();
  const view = (accountId, method, args = {}) =>
    viewFunction(rpc, accountId, method, args);

  const balances = await verifyPortfolioBalances({
    fetchSepoliaUsdcRaw: async (evm) =>
      String((await erc20Balance(USDC_SEPOLIA, evm)) ?? "0"),
    fetchSepoliaEthWei: async (evm) => String(await ethBalance(evm)),
    fetchIntentsUsdc: async (evm) => intentsMtBalance(rpc, evm),
    intents_signer_id: portfolio.intents_signer_id,
  });
  out.steps.balances = {
    ok: balances.ok,
    balance_usdc_raw: balances.balance_usdc_raw,
    reason: balances.reason,
  };
  if (!balances.ok) {
    out.reason = "BALANCE_UNVERIFIED";
    save("gate-k-first-trade.json", out);
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  const hydrated = await hydrateMandateFromChain({
    view,
    portfolio,
    balance_usdc_raw: balances.balance_usdc_raw,
  });
  out.steps.mandate = {
    ok: hydrated.ok,
    reason: hydrated.reason,
    epoch: hydrated.mandate?.mandate_epoch,
    policy_hash: hydrated.mandate?.policy_hash,
    autonomous_trading: hydrated.mandate?.autonomous_trading,
    per_trade: hydrated.mandate?.per_trade_limit_usdc_raw,
    revoked: hydrated.mandate?.revoked,
    paused: hydrated.mandate?.paused,
  };
  if (!hydrated.ok) {
    out.reason = hydrated.reason || "MANDATE_HYDRATE_FAILED";
    save("gate-k-first-trade.json", out);
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  const near = await connectWithAccounts(rpc, CREDS, [
    portfolio.owner_account,
    portfolio.agent_account,
    portfolio.reconciler_account,
  ].filter(Boolean));
  const agent = await near.account(portfolio.agent_account);
  const reconciler = await near.account(portfolio.reconciler_account);

  const attestor = createAttestorService({
    seedPath: join(DATA, "attestor.seed.json"),
  });

  const quoteFn = async ({ originAsset, destinationAsset, amount, deadlineMs }) => {
    const agentRequest = {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset,
      amount: String(amount),
      refundTo: portfolio.intents_signer_id,
      refundType: "ORIGIN_CHAIN",
      recipient: portfolio.intents_signer_id,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + (deadlineMs || 45 * 60 * 1000)).toISOString(),
    };
    const res = await fetch(`${TIDEPOOL}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(agentRequest),
    });
    const quote = await res.json();
    if (quote?.error) throw new Error(String(quote.error));
    return quote;
  };

  out.acceptance_mode = ACCEPTANCE;

  console.error("[gate-k] running live AI pipeline (may NO_TRADE)...");
  // Dry decision first (no executeDeps) so we can apply acceptance override.
  const trace = await runGateKPipeline({
    mandate: hydrated.mandate,
    portfolio,
    portfolioId: FIRST_TEST.portfolio_id,
    balances: { usdc_raw: balances.balance_usdc_raw },
    useLlm: true,
    mode: MODE.DRY_RUN,
    operatorConfirm: false,
    authenticated: true,
    reconcilerOk: true,
    store,
    viewFunction: view,
    quoteFn,
  });

  const strategistProposal = trace.gate_j?.strategist?.proposal || null;
  const fitterBlock = trace.gate_j?.fitter || trace.gate_j?.fitter_after_critic;
  out.steps.ai = {
    decision: trace.enforcement?.decision,
    reason_codes: trace.enforcement?.reason_codes,
    models: trace.gate_j?.summary?.models,
    strategist: {
      choice: strategistProposal?.choice,
      thesis: strategistProposal?.thesis,
      size_raw: strategistProposal?.proposed_size_usdc_raw,
      edge_bps: strategistProposal?.expected_benefit?.edge_bps,
      fee_bps: strategistProposal?.estimated_costs?.fee_bps,
      impact_bps: strategistProposal?.estimated_costs?.price_impact_bps,
      llm: trace.gate_j?.strategist?.llm,
    },
    fitter: {
      outcome: fitterBlock?.outcome,
      fitted_size: fitterBlock?.fitted_proposal?.proposed_size_usdc_raw,
      reason_codes: fitterBlock?.reason_codes,
    },
    critic: {
      verdict: trace.gate_j?.critic?.review?.verdict,
      llm: trace.gate_j?.critic?.llm,
    },
    safety: trace.safety
      ? { ok: trace.safety.ok, size: trace.safety.safe_proposal?.proposed_size_usdc_raw }
      : null,
    economics: trace.economics,
    preview: trace.preview,
  };

  let exec = null;
  let execKey = null;

  const canAcceptOverride =
    ACCEPTANCE &&
    strategistProposal?.choice === "TRADE" &&
    !hydrated.mandate.revoked &&
    !hydrated.mandate.paused;

  if (trace.signing && trace.execution?.signed) {
    exec = trace.execution.execution;
    execKey = trace.execution.exec_key;
  } else if (canAcceptOverride) {
    console.error(
      "[gate-k] ACCEPTANCE OVERRIDE — Strategist TRADE; bypassing fitter/critic/economics for one proof trade"
    );
    const safety = applyGateKSafety({
      mandate: hydrated.mandate,
      fittedProposal: {
        ...strategistProposal,
        // Prefer original proposed size; safety clamps to ≤26 USDC / mandate / balance
        proposed_size_usdc_raw:
          strategistProposal.proposed_size_usdc_raw || "26000000",
        min_viable_size_usdc_raw:
          strategistProposal.min_viable_size_usdc_raw || "1",
      },
      portfolioId: FIRST_TEST.portfolio_id,
    });
    out.steps.acceptance = {
      enabled: true,
      note: "Operator authorized Gate K acceptance: proceed despite ECONOMIC/CRITIC blocks",
      prior_block: trace.enforcement?.reason_codes || [],
      safety_ok: safety.ok,
      size: safety.safe_proposal?.proposed_size_usdc_raw,
    };
    if (!safety.ok) {
      out.reason = "ACCEPTANCE_SAFETY_FAILED";
      out.detail = safety;
      save("gate-k-first-trade.json", out);
      console.log(JSON.stringify(out, null, 2));
      process.exit(1);
    }

    const quoteResult = await fetchFreshExecutableQuote({
      amountRaw: safety.safe_proposal.proposed_size_usdc_raw,
      quoteFn,
    });
    out.steps.fresh_quote = {
      ok: quoteResult.ok,
      reason: quoteResult.reason,
      quote_hash: quoteResult.quote?.quote_hash,
      amount_out: quoteResult.quote?.amount_out,
      deposit: quoteResult.quote?.deposit_address,
    };
    if (!quoteResult.ok) {
      out.reason = "NO_FRESH_QUOTE";
      save("gate-k-first-trade.json", out);
      console.log(JSON.stringify(out, null, 2));
      process.exit(1);
    }

    // Attestor requires Tidepool envelope; normalized quote spreads raw fields.
    const agentRequest = buildAgentRequest({
      amount: safety.safe_proposal.proposed_size_usdc_raw,
      recipient: portfolio.intents_signer_id,
    });
    // Align agentRequest deadline with quote when present
    if (quoteResult.quote?.quoteRequest?.deadline) {
      agentRequest.deadline = quoteResult.quote.quoteRequest.deadline;
    } else if (quoteResult.quote?.quote?.deadline) {
      agentRequest.deadline = quoteResult.quote.quote.deadline;
    }

    process.env.GATE_K_ALLOW_SIGN = "1";
    const signed = await executeGateKTrade(
      {
        store,
        getNearAccounts: async () => ({ agent, reconciler }),
        viewFunction: view,
        attestor,
        eth,
        logger: console,
      },
      {
        portfolioId: FIRST_TEST.portfolio_id,
        portfolio,
        mandate: hydrated.mandate,
        safeProposal: {
          ...safety.safe_proposal,
          operation_id: `k-accept-${Date.now()}`,
        },
        quote: quoteResult.quote,
        economic: {
          ok: true,
          reason: "ACCEPTANCE_OVERRIDE",
          note: "Economics/critic bypassed under explicit operator acceptance authorization",
          strategist_edge_bps: strategistProposal.expected_benefit?.edge_bps,
        },
        agentRequest,
        authenticated: true,
        reconcilerOk: true,
        operatorConfirmed: true,
        mode: MODE.TESTNET_EXECUTION,
        idempotencyKey: `gate_k:acceptance:${FIRST_TEST.portfolio_id}:v1`,
      }
    );
    out.steps.execution = {
      ok: signed.ok,
      signed: signed.signed,
      reason: signed.reason,
      operation_id: signed.execution?.operation_id,
      propose_tx: signed.execution?.propose_tx,
      sign_tx: signed.execution?.sign_tx,
      amount: signed.execution?.amount,
      to: signed.execution?.to,
      nonce: signed.execution?.nonce,
      gas_price: signed.execution?.gas_price,
      acceptance_override: true,
    };
    out.steps.ai.signing = !!signed.signed;
    out.steps.ai.execution = out.steps.execution;
    if (!signed.ok || !signed.signed) {
      out.reason = signed.reason || "SIGN_FAILED";
      out.pass = false;
      save("gate-k-first-trade.json", out);
      console.log(JSON.stringify(out, null, 2));
      process.exit(1);
    }
    exec = signed.execution;
    execKey = signed.exec_key;
  } else {
    out.reason = "NO_QUALIFYING_TRADE_OR_SIGN_BLOCKED";
    out.detail = trace.enforcement;
    out.hint = ACCEPTANCE
      ? "Acceptance enabled but Strategist did not propose TRADE"
      : "Re-run with --acceptance after operator approval to bypass economic/critic for one proof";
    out.pass = false;
    save("gate-k-first-trade.json", out);
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const amount = exec.amount;
  const deposit = exec.to;
  const nonce = BigInt(exec.nonce);
  const gasPrice = BigInt(exec.gas_price);
  const opId = exec.operation_id;

  // Extract MPC signature from NEAR tx
  const signFull = await nearRpc(rpc, "EXPERIMENTAL_tx_status", [
    exec.sign_tx,
    portfolio.agent_account,
  ]);
  const extracted = extractSig(signFull);
  out.steps.mpc = {
    near_sign_tx: exec.sign_tx,
    near_propose_tx: exec.propose_tx,
    found: extracted.found,
  };
  if (!extracted.found) {
    out.reason = "MPC_SIG_NOT_FOUND";
    out.pass = false;
    out.note = "Signature may still be in-flight; do not mark success";
    save("gate-k-first-trade.json", out);
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  const data = erc20TransferData(deposit, BigInt(amount));
  const digest = eip155UnsignedDigest({
    nonce,
    gasPrice,
    gasLimit: GAS_LIMIT,
    to: USDC_SEPOLIA,
    data,
    chainId: CHAIN_ID,
  });
  let { r, s, recoveryId } = mpcToRsV(extracted.signature_json);
  let recovered = recoverFromHash(digest, r, s, recoveryId);
  if (recovered.toLowerCase() !== portfolio.intents_signer_id.toLowerCase()) {
    const alt = recoveryId ^ 1;
    if (
      recoverFromHash(digest, r, s, alt).toLowerCase() ===
      portfolio.intents_signer_id.toLowerCase()
    ) {
      recoveryId = alt;
      recovered = portfolio.intents_signer_id;
    }
  }
  out.steps.recover = {
    recovered,
    expected: portfolio.intents_signer_id,
    match: recovered.toLowerCase() === portfolio.intents_signer_id.toLowerCase(),
  };
  if (!out.steps.recover.match) {
    out.reason = "RECOVERED_ADDRESS_MISMATCH";
    out.pass = false;
    save("gate-k-first-trade.json", out);
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  // Final mandate revalidation before broadcast (ECDSA itself is not revocable)
  const reval = await revalidateMandate({
    view,
    portfolio,
    balance_usdc_raw: balances.balance_usdc_raw,
    expected_revalidate_key: hydrated.mandate.revalidate_key,
  });
  out.steps.pre_broadcast_revalidate = {
    ok: reval.ok,
    reason: reval.reason,
  };
  // Still broadcast if signed — honest tracking of in-flight signature
  if (!reval.ok) {
    out.note =
      "Mandate changed after signature export; broadcasting for honest reconciliation of irrevocable ECDSA";
  }

  const raw = serializeSignedTx({
    nonce,
    gasPrice,
    gasLimit: GAS_LIMIT,
    to: USDC_SEPOLIA,
    data,
    chainId: CHAIN_ID,
    r,
    s,
    recoveryId,
  });
  console.error("[gate-k] broadcasting Sepolia tx...");
  const send = await eth("eth_sendRawTransaction", [raw]);
  const receipt = send.result ? await waitReceipt(send.result) : null;
  out.steps.broadcast = {
    tx: send.result || null,
    error: send.error || null,
    status: receipt?.status || null,
    explorer: send.result
      ? `https://sepolia.etherscan.io/tx/${send.result}`
      : null,
    deposit_address: deposit,
    amount,
  };

  execKey = execKey || `gate_k:${FIRST_TEST.portfolio_id}:${opId}`;
  store.finishExecution(execKey, {
    status:
      receipt?.status === "0x1"
        ? "BROADCAST_PENDING_RECONCILE"
        : send.result
          ? "BROADCAST_PENDING_RECEIPT"
          : "BROADCAST_FAILED",
    sepolia_tx: send.result || null,
    receipt_status: receipt?.status || null,
  });

  if (receipt?.status !== "0x1") {
    out.reason = "SEPOLIA_BROADCAST_OR_RECEIPT_FAILED";
    out.pass = false;
    save("gate-k-first-trade.json", out);
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  try {
    await fetch(`${TIDEPOOL}/v0/deposit/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        txHash: send.result,
        depositAddress: deposit,
      }),
    });
  } catch (e) {
    out.steps.tidepool_submit_error = String(e?.message || e);
  }

  let terminal = null;
  for (let i = 0; i < 48; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const st = await fetch(
      `${TIDEPOOL}/v0/status?depositAddress=${encodeURIComponent(deposit)}`
    ).then((r) => r.json());
    console.error("[gate-k] tidepool", i, st.status);
    if (["SUCCESS", "REFUNDED", "FAILED", "EXPIRED"].includes(st.status)) {
      terminal = st;
      break;
    }
  }
  out.steps.tidepool = {
    status: terminal?.status || "PENDING_TIMEOUT",
    nearTxHashes: terminal?.swapDetails?.nearTxHashes || [],
  };

  const pending = await view(portfolio.policy_contract, "get_pending", {
    operation_id: opId,
  });
  const verified = await verifyBeforeReconcile({
    pendingOp: pending,
    originTxHash: send.result,
    expectedSender: portfolio.intents_signer_id,
    expectedToken: USDC_SEPOLIA,
    expectedRecipient: deposit,
    expectedAmount: amount,
    depositAddress: deposit,
  });
  out.steps.verification = {
    may_reconcile: verified.may_reconcile,
    derived: verified.derived,
    origin_ok: verified.origin?.ok,
    tidepool_ok: verified.tidepool?.ok,
  };

  if (verified.may_reconcile) {
    const recTx = await reconciler.functionCall({
      contractId: portfolio.policy_contract,
      methodName: "reconcile_pending",
      args: {
        operation_id: opId,
        settlement_state: verified.derived.settlement_state,
        evidence_hash: String(verified.derived.evidence_hash || "").slice(0, 128),
      },
      gas: BigInt("40000000000000"),
      attachedDeposit: 0n,
    });
    out.steps.reconcile = {
      tx: recTx.transaction.hash,
      actor: portfolio.reconciler_account,
      settlement_state: verified.derived.settlement_state,
    };
    store.finishExecution(execKey, {
      status:
        verified.derived.settlement_state === "Success"
          ? "SUCCESS"
          : "RECONCILED_NON_SUCCESS",
      reconcile_tx: recTx.transaction.hash,
      settlement_state: verified.derived.settlement_state,
    });
  } else {
    out.steps.reconcile = {
      skipped: true,
      reason: verified.derived?.notes || "may_reconcile_false",
    };
  }

  const balAfter = await verifyPortfolioBalances({
    fetchSepoliaUsdcRaw: async (evm) =>
      String((await erc20Balance(USDC_SEPOLIA, evm)) ?? "0"),
    fetchSepoliaEthWei: async (evm) => String(await ethBalance(evm)),
    fetchIntentsUsdc: async (evm) => intentsMtBalance(rpc, evm),
    intents_signer_id: portfolio.intents_signer_id,
  });
  const exposure = await view(portfolio.policy_contract, "get_exposure_snapshot");
  out.steps.after = {
    balance_usdc_raw: balAfter.balance_usdc_raw,
    exposure,
  };

  out.pass =
    out.steps.broadcast?.status === "0x1" &&
    out.steps.tidepool?.status === "SUCCESS" &&
    out.steps.reconcile?.settlement_state === "Success";
  out.reason = out.pass
    ? "AI_DIRECTED_TRADE_RECONCILED"
    : "PARTIAL_OR_PENDING_SEE_STEPS";

  save("gate-k-first-trade.json", out);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  save("gate-k-first-trade.json", {
    ok: false,
    pass: false,
    error: String(e?.message || e).slice(0, 500),
  });
  process.exit(1);
});
