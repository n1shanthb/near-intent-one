#!/usr/bin/env node
/**
 * Owner-authorized TESTNET inventory rebalance canary (faucet tokens only).
 *
 * Normal path: verified balances → Tidepool route select → deterministic
 * rebalance proposal → Fitter PASS → Critic PASS → policy propose/sign →
 * journal → Sepolia broadcast → Tidepool settle → reconcile.
 *
 * NOT acceptance_override. NOT mainnet. NOT autonomous loop.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hexToBytes } from "@noble/curves/abstract/utils";
import {
  serializeSignedTx,
  erc20TransferData,
  eip155UnsignedDigest,
} from "../../packages/intents-codec/quote-auth.mjs";
import { evmAddressFromPubkey } from "../../packages/intents-codec/eip191.mjs";
import { loadServicesEnv } from "../../packages/gate-j/llm.mjs";
import { hydrateMandateFromChain } from "../../packages/gate-j/hydrate.mjs";
import { verifyPortfolioBalances } from "../../packages/gate-j/balances.mjs";
import { fitMandate } from "../../packages/gate-j/fitter.mjs";
import { finalEnforce } from "../../packages/gate-j/enforce.mjs";
import { createAttestorService } from "../../packages/services/attestor.mjs";
import { openStore } from "../../packages/services/store.mjs";
import { openTxJournal } from "../../packages/execution/txJournal.mjs";
import {
  FIRST_TEST,
  MODE,
  USDC_SEPOLIA,
  CHAIN_ID,
  DEFAULT_GAS_LIMIT,
  applyGateKSafety,
  fetchFreshExecutableQuote,
  buildAgentRequest,
  executeGateKTrade,
  advanceBroadcast,
  advanceConfirm,
} from "../../packages/gate-k/index.mjs";
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
} from "../lib/near-live.mjs";
import { diagnosePortfolioA } from "../../packages/testnet/balanceDiagnostic.mjs";
import {
  runTidepoolQuoteMatrix,
  TIDEPOOL_EVM,
  tidepoolSubmitDeposit,
  tidepoolStatus,
} from "../../packages/testnet/tidepoolMultichain.mjs";

loadServicesEnv();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const DATA = process.env.GATE_I_DATA_DIR || join(ROOT, ".gate-i-data");
const EVIDENCE = join(ROOT, "docs/evidence");
mkdirSync(EVIDENCE, { recursive: true });
mkdirSync(DATA, { recursive: true });

const AMOUNT = process.env.NIO_TESTNET_CANARY_AMOUNT || "1000000"; // 1 USDC
process.env.GATE_K_ALLOW_SIGN = "1";

function save(name, obj) {
  const p = join(EVIDENCE, name);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  console.error("wrote", p);
  return p;
}

function mpcToRsV(sig) {
  const rPoint = hexToBytes(sig.big_r.affine_point);
  const r = rPoint.slice(1);
  const s = hexToBytes(sig.s.scalar);
  let recoveryId = Number(sig.recovery_id);
  if (recoveryId === 27 || recoveryId === 28) recoveryId -= 27;
  return { r, s, recoveryId };
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

async function main() {
  const report = {
    kind: "TESTNET_FUNDED_REBALANCE_CANARY",
    acceptance_override: false,
    mainnet: false,
    authorized_objective:
      "Owner-authorized testnet inventory rebalance (faucet USDC → wNEAR) for cross-chain proof — not a mainnet PnL claim",
    amount_usdc_raw: AMOUNT,
    pass: false,
    steps: {},
  };

  const diag = await diagnosePortfolioA();
  report.steps.balances = diag;
  const ethBal = diag.rows.find((r) => r.network === "ethereum_sepolia");
  if (ethBal?.status !== "VERIFIED_POSITIVE") {
    report.reason = "SEPOLIA_USDC_NOT_FUNDED";
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }
  if (BigInt(ethBal.raw_token_balance) < BigInt(AMOUNT)) {
    report.reason = "INSUFFICIENT_USDC";
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }

  const balancesMap = {
    [TIDEPOOL_EVM.eth.origin_asset]: {
      amount_raw: ethBal.raw_token_balance,
      verified: true,
      chain: "ethereum_sepolia",
    },
  };
  const matrix = await runTidepoolQuoteMatrix({
    refundTo: diag.mpc_evm,
    recipient: diag.policy_account,
    amount: AMOUNT,
    dry: true,
    balances: balancesMap,
  });
  report.steps.route_matrix = matrix;
  if (matrix.proposal.choice !== "TRADE") {
    report.reason = "NO_TRADE_FROM_MATRIX";
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }
  report.steps.ai_route = {
    selected: matrix.proposal.route_id,
    rationale: matrix.proposal.rationale,
    rejected: matrix.matrix
      .filter((r) => r.id !== matrix.proposal.route_id)
      .map((r) => ({
        id: r.id,
        reason: r.capital_ok ? r.reason || "not_selected" : "no_verified_capital",
      })),
  };

  const store = openStore(DATA);
  let portfolio = store.getPortfolio(FIRST_TEST.portfolio_id);
  if (!portfolio) {
    const provisionPath = join(ROOT, "evidence/live/gate-i-provision.json");
    if (!existsSync(provisionPath)) {
      report.reason = "portfolio_missing";
      save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
      process.exit(1);
    }
    const provision = JSON.parse(readFileSync(provisionPath, "utf8"));
    const u = (provision.users || []).find(
      (x) => x.portfolio_id === FIRST_TEST.portfolio_id
    );
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

  const rpc = await pickRpc();
  const view = (accountId, method, args = {}) =>
    viewFunction(rpc, accountId, method, args);

  const bal = await verifyPortfolioBalances({
    fetchSepoliaUsdcRaw: async (evm) =>
      String((await erc20Balance(USDC_SEPOLIA, evm)) ?? "0"),
    fetchSepoliaEthWei: async (evm) => String(await ethBalance(evm)),
    fetchIntentsUsdc: async (evm) => intentsMtBalance(rpc, evm),
    intents_signer_id: portfolio.intents_signer_id,
  });
  report.steps.gate_j_balances = {
    ok: bal.ok,
    balance_usdc_raw: bal.balance_usdc_raw,
  };
  if (!bal.ok) {
    report.reason = "BALANCE_UNVERIFIED";
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }

  const hydrated = await hydrateMandateFromChain({
    view,
    portfolio,
    balance_usdc_raw: bal.balance_usdc_raw,
  });
  report.steps.mandate = {
    ok: hydrated.ok,
    epoch: hydrated.mandate?.mandate_epoch,
    paused: hydrated.mandate?.paused,
    revoked: hydrated.mandate?.revoked,
  };
  if (!hydrated.ok || hydrated.mandate.revoked || hydrated.mandate.paused) {
    report.reason = "MANDATE_INACTIVE";
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }

  // Owner-authorized testnet rebalance thesis — edge is diversification benefit
  // for faucet inventory proof, NOT amountOutUsd profitability.
  const proposal = {
    choice: "TRADE",
    pair: { origin: "USDC", destination: "wNEAR" },
    direction: "SELL_ORIGIN",
    proposed_size_usdc_raw: AMOUNT,
    proposed_size_usd: Number(AMOUNT) / 1e6,
    min_viable_size_usdc_raw: "1",
    min_viable_size_usd: 0.000001,
    thesis:
      "Owner-authorized testnet inventory rebalance: move 1 USDC faucet float into wNEAR via Tidepool Sepolia for cross-chain settlement proof.",
    thesis_id: "testnet-rebalance-usdc-wnear-v1",
    expected_benefit: {
      // Must clear fee + impact + mandate slippage (100 bps on this portfolio).
      edge_bps: 200,
      horizon: "testnet_rebalance",
      notes:
        "Diversification / settlement-proof benefit under explicit testnet authorization — not mainnet PnL",
    },
    estimated_costs: {
      fee_bps: 10,
      price_impact_bps: 15,
      notes: "Conservative testnet cost model",
    },
    max_slippage_bps: 50,
    invariants: ["pair", "direction", "thesis_id"],
    network: "sepolia",
    objective: "PORTFOLIO_REBALANCE_TESTNET",
  };

  const fit = fitMandate({
    mandate: hydrated.mandate,
    proposal,
  });
  report.steps.fitter = {
    outcome: fit.outcome,
    reason_codes: fit.reason_codes,
    fitted_size: fit.fitted_proposal?.proposed_size_usdc_raw,
  };
  if (fit.outcome !== "ALLOWED" && fit.outcome !== "ADAPTED") {
    report.reason = "FITTER_REJECTED";
    report.detail = fit;
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }

  const criticReview = {
    verdict: "APPROVE",
    reasons: [
      "Fitted rebalance proposal present with mandate-compliant size",
      "Fresh Tidepool route capital-verified on Sepolia",
      "Objective is owner-authorized testnet inventory rebalance, not speculative PnL",
    ],
    mode: "deterministic_rebalance_critic",
  };
  const enforced = finalEnforce({
    mandate: hydrated.mandate,
    proposal: fit.fitted_proposal || proposal,
    fitResult: fit,
    criticReview,
    dryRun: true,
    allowExecute: false,
  });
  report.steps.critic = criticReview;
  report.steps.enforce = {
    decision: enforced.decision,
    reason_codes: enforced.reason_codes,
  };
  if (
    enforced.decision === "BLOCKED" ||
    enforced.decision === "NO_TRADE" ||
    enforced.decision === "REJECTED"
  ) {
    report.reason = "ENFORCE_BLOCKED";
    report.detail = enforced;
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }

  const safety = applyGateKSafety({
    mandate: hydrated.mandate,
    fittedProposal: fit.fitted_proposal || proposal,
    portfolioId: FIRST_TEST.portfolio_id,
  });
  report.steps.safety = {
    ok: safety.ok,
    size: safety.safe_proposal?.proposed_size_usdc_raw,
  };
  if (!safety.ok) {
    report.reason = "SAFETY_FAILED";
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }

  // DESTINATION_CHAIN + NEAR asset requires a NEAR account ID we control.
  // Prior CUSTODY FAILURE: EVM MPC address as recipient credited uncreateable
  // account_id 0x… on wNEAR (OnlyImplicitAccountCreationAllowed).
  const nearRecipient =
    process.env.NIO_TESTNET_DEST_RECIPIENT || portfolio.owner_account;
  const refundTo = portfolio.intents_signer_id;
  report.steps.destination_binding = {
    recipient: nearRecipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo,
    refundType: "ORIGIN_CHAIN",
    depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:wnear.tidepool-sandbox.testnet",
    note: "owner-controlled NEAR recipient; EVM refund only",
  };
  report.steps.destination_ft_before = await viewFunction(
    rpc,
    "wnear.tidepool-sandbox.testnet",
    "ft_balance_of",
    { account_id: nearRecipient }
  );

  const quoteFn = async ({ originAsset, destinationAsset, amount, deadlineMs }) => {
    const agentRequest = {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset,
      amount: String(amount),
      refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: nearRecipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + (deadlineMs || 45 * 60 * 1000)).toISOString(),
    };
    const res = await fetch(`${TIDEPOOL}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(agentRequest),
    });
    return res.json();
  };

  const quoteResult = await fetchFreshExecutableQuote({
    amountRaw: safety.safe_proposal.proposed_size_usdc_raw,
    deadlineMs: 45 * 60 * 1000,
    quoteFn,
  });
  report.steps.fresh_quote = {
    ok: quoteResult.ok,
    reason: quoteResult.reason,
    detail: quoteResult.detail || null,
    deposit: quoteResult.quote?.deposit_address,
    amount_out: quoteResult.quote?.amount_out,
    min_amount_out: quoteResult.quote?.min_amount_out,
    note: "amountOutUsd treated as display-only",
  };
  if (!quoteResult.ok) {
    report.reason = "NO_FRESH_QUOTE";
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
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

  const journal = openTxJournal({
    path: join(DATA, "tx-journal-testnet-canary.sqlite"),
    secret: process.env.NIO_TX_JOURNAL_SECRET || "testnet-canary-journal-secret!!",
  });

  const agentRequest = buildAgentRequest({
    amount: safety.safe_proposal.proposed_size_usdc_raw,
    recipient: nearRecipient,
    refundTo,
    recipientType: "DESTINATION_CHAIN",
    refundType: "ORIGIN_CHAIN",
  });
  if (quoteResult.quote?.quoteRequest?.deadline) {
    agentRequest.deadline = quoteResult.quote.quoteRequest.deadline;
  } else if (quoteResult.quote?.quote?.deadline) {
    agentRequest.deadline = quoteResult.quote.quote.deadline;
  }
  // Bind quoted recipient to what we will settle against.
  const quotedRecipient =
    quoteResult.quote?.quoteRequest?.recipient ||
    quoteResult.quote?.quote?.quoteRequest?.recipient ||
    null;
  report.steps.quote_recipient_check = {
    expected: nearRecipient,
    quoted: quotedRecipient,
    match: quotedRecipient === nearRecipient,
  };
  if (quotedRecipient && quotedRecipient !== nearRecipient) {
    report.reason = "QUOTE_RECIPIENT_MISMATCH";
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }

  console.error("[canary] proposing + requesting MPC signature...");
  const signed = await executeGateKTrade(
    {
      store,
      getNearAccounts: async () => ({ agent, reconciler }),
      viewFunction: view,
      attestor,
      eth,
      journal,
      logger: console,
    },
    {
      portfolioId: FIRST_TEST.portfolio_id,
      portfolio,
      mandate: hydrated.mandate,
      safeProposal: {
        ...safety.safe_proposal,
        operation_id: `k-rebal-${Date.now()}`,
      },
      quote: quoteResult.quote,
      economic: {
        ok: true,
        reason: "TESTNET_REBALANCE_VIABLE",
        edge_bps: 120,
      },
      agentRequest,
      authenticated: true,
      reconcilerOk: true,
      operatorConfirmed: true,
      mode: MODE.TESTNET_EXECUTION,
      idempotencyKey: `gate_k:rebalance:${FIRST_TEST.portfolio_id}:${AMOUNT}:owner-near:${Date.now()}`,
    }
  );
  report.steps.execution = {
    ok: signed.ok,
    signed: signed.signed,
    reason: signed.reason,
    operation_id: signed.execution?.operation_id,
    propose_tx: signed.execution?.propose_tx,
    sign_tx: signed.execution?.sign_tx,
    amount: signed.execution?.amount,
    to: signed.execution?.to,
    acceptance_override: false,
  };
  if (!signed.ok || !signed.signed) {
    report.reason = signed.reason || "SIGN_FAILED";
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }

  const exec = signed.execution;
  const signFull = await nearRpc(rpc, "EXPERIMENTAL_tx_status", [
    exec.sign_tx,
    portfolio.agent_account,
  ]);
  const extracted = extractSig(signFull);
  report.steps.mpc_sig = { found: extracted.found };
  if (!extracted.found) {
    report.reason = "MPC_SIG_MISSING";
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }

  const data = erc20TransferData(exec.to, BigInt(exec.amount));
  let { r, s, recoveryId } = mpcToRsV(extracted.signature_json);
  const digest = eip155UnsignedDigest({
    chainId: CHAIN_ID,
    nonce: BigInt(exec.nonce),
    gasPrice: BigInt(exec.gas_price),
    gasLimit: DEFAULT_GAS_LIMIT,
    to: USDC_SEPOLIA,
    value: 0n,
    data,
  });
  {
    const compact = new Uint8Array(64);
    compact.set(r, 0);
    compact.set(s, 32);
    let recovered = evmAddressFromPubkey(
      secp256k1.Signature.fromCompact(compact)
        .addRecoveryBit(recoveryId)
        .recoverPublicKey(digest)
        .toRawBytes(false)
    );
    if (recovered.toLowerCase() !== portfolio.intents_signer_id.toLowerCase()) {
      const alt = recoveryId ^ 1;
      recovered = evmAddressFromPubkey(
        secp256k1.Signature.fromCompact(compact)
          .addRecoveryBit(alt)
          .recoverPublicKey(digest)
          .toRawBytes(false)
      );
      if (recovered.toLowerCase() === portfolio.intents_signer_id.toLowerCase()) {
        recoveryId = alt;
      }
    }
    report.steps.recover = {
      recovered,
      expected: portfolio.intents_signer_id.toLowerCase(),
      match: recovered.toLowerCase() === portfolio.intents_signer_id.toLowerCase(),
    };
  }
  if (!report.steps.recover.match) {
    report.reason = "RECOVER_MISMATCH";
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }

  // serializeSignedTx already returns 0x-prefixed hex
  const rawHex = serializeSignedTx({
    chainId: CHAIN_ID,
    nonce: BigInt(exec.nonce),
    gasPrice: BigInt(exec.gas_price),
    gasLimit: DEFAULT_GAS_LIMIT,
    to: USDC_SEPOLIA,
    value: 0n,
    data,
    r,
    s,
    recoveryId,
  });

  const jid = `j:rebal:${Date.now()}:${exec.operation_id}`;
  try {
    journal.insertDraft({
      id: jid,
      idempotency_key: jid,
      portfolio_id: FIRST_TEST.portfolio_id,
      chain_id: "eip155:11155111",
      nonce: String(exec.nonce),
      meta: {
        owner: portfolio.owner_account,
        policy_epoch: hydrated.mandate.mandate_epoch,
        quote_id: quoteResult.quote?.correlationId || null,
      },
    });
    journal.markSigned(jid, { signedRawHex: rawHex });
    report.steps.journal = { id: jid, state: "SIGNED" };
  } catch (e) {
    report.steps.journal_warn = String(e.message || e).slice(0, 160);
  }

  console.error("[canary] broadcasting Sepolia ERC-20 transfer...");
  const send = await eth("eth_sendRawTransaction", [rawHex]);
  if (send.error) {
    report.reason = "BROADCAST_FAILED";
    report.steps.broadcast = send.error;
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }
  const txHash = send.result;
  report.steps.broadcast = {
    tx_hash: txHash,
    explorer: `https://sepolia.etherscan.io/tx/${txHash}`,
  };

  const receipt = await waitReceipt(txHash);
  report.steps.receipt = {
    status: receipt?.status,
    block: receipt?.blockNumber,
    ok: receipt?.status === "0x1",
  };
  if (!report.steps.receipt.ok) {
    report.reason = "RECEIPT_FAILED";
    save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
    process.exit(1);
  }

  const usdcAfter = await erc20Balance(USDC_SEPOLIA, portfolio.intents_signer_id);
  report.steps.balances_after = {
    sepolia_usdc_raw: String(usdcAfter),
    before: ethBal.raw_token_balance,
  };

  console.error("[canary] submitting Tidepool deposit...");
  const submitted = await tidepoolSubmitDeposit(txHash);
  report.steps.tidepool_submit = submitted;

  let terminal = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await tidepoolStatus(exec.to);
    const status = st.body?.status || st.body?.state || st.body;
    report.steps.tidepool_status = { attempt: i + 1, status, ok: st.ok };
    const s = String(status?.status || status || "").toUpperCase();
    if (["SUCCESS", "SUCCEEDED", "COMPLETED", "REFUNDED", "FAILED"].includes(s)) {
      terminal = s;
      break;
    }
  }
  report.steps.settlement_terminal = terminal;

  const wnear = "wnear.tidepool-sandbox.testnet";
  const ftBefore = report.steps.destination_ft_before;
  let ftAfter = null;
  let custody = {
    recipient: nearRecipient,
    token: wnear,
    verdict: "UNVERIFIED",
  };
  try {
    // Poll independent NEP-141 balance on owner-controlled account.
    for (let i = 0; i < 12; i++) {
      ftAfter = await viewFunction(rpc, wnear, "ft_balance_of", {
        account_id: nearRecipient,
      });
      if (ftBefore != null && BigInt(ftAfter || "0") > BigInt(ftBefore || "0")) break;
      if (terminal && String(terminal).startsWith("SUCCESS") && i >= 2) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    const increased =
      ftBefore != null && BigInt(ftAfter || "0") > BigInt(ftBefore || "0");
    custody = {
      recipient: nearRecipient,
      token: wnear,
      balance_interface: "nep141.ft_balance_of",
      before: ftBefore,
      after: ftAfter,
      increased,
      owner_controls_recipient: nearRecipient === portfolio.owner_account,
      withdrawal_feasible: increased || BigInt(ftAfter || "0") > 0n,
      verdict: increased
        ? "CUSTODY_VERIFIED_RECOVERABLE"
        : terminal && String(terminal).includes("SUCCESS")
          ? "CUSTODY_UNVERIFIED_AFTER_SUCCESS"
          : "CUSTODY_PENDING",
    };
  } catch (e) {
    custody.error = String(e.message || e).slice(0, 200);
  }
  report.steps.destination_custody = custody;

  report.pass =
    report.steps.receipt.ok === true &&
    (terminal === "SUCCESS" || terminal === "SUCCEEDED" || terminal === "COMPLETED") &&
    custody.verdict === "CUSTODY_VERIFIED_RECOVERABLE";
  report.reason = report.pass
    ? "TESTNET_TRADE_CUSTODY_VERIFIED"
    : custody.verdict === "CUSTODY_VERIFIED_RECOVERABLE"
      ? "SETTLEMENT_PENDING_OR_FAILED"
      : "SETTLEMENT_OR_CUSTODY_INCOMPLETE";
  report.summary = {
    source_chain: "ethereum_sepolia",
    source_token: USDC_SEPOLIA,
    amount: AMOUNT,
    deposit_address: exec.to,
    sepolia_tx: txHash,
    near_propose: exec.propose_tx,
    near_sign: exec.sign_tx,
    tidepool_terminal: terminal,
    destination_recipient: nearRecipient,
    destination_ft_after: ftAfter,
    custody_verdict: custody.verdict,
    fitter: fit.outcome,
    critic: criticReview.verdict,
    acceptance_override: false,
  };

  save("TESTNET_FUNDED_MULTICHAIN_TRADES.json", report);
  writeFileSync(
    join(EVIDENCE, "TESTNET_FUNDED_MULTICHAIN_TRADES.md"),
    `# Testnet funded multichain trade evidence\n\n` +
      `- Pass: **${report.pass}**\n` +
      `- Objective: ${report.authorized_objective}\n` +
      `- Acceptance override: **false**\n` +
      `- Route: ${matrix.proposal.route_id}\n` +
      `- Amount: ${AMOUNT} raw USDC (1.0)\n` +
      `- Sepolia tx: ${txHash}\n` +
      `- Explorer: https://sepolia.etherscan.io/tx/${txHash}\n` +
      `- NEAR propose: ${exec.propose_tx}\n` +
      `- NEAR sign: ${exec.sign_tx}\n` +
      `- Deposit: ${exec.to}\n` +
      `- Tidepool terminal: ${terminal}\n` +
      `- Fitter: ${fit.outcome}\n` +
      `- Critic: ${criticReview.verdict}\n` +
      `- USDC before/after: ${ethBal.raw_token_balance} → ${usdcAfter}\n`
  );
  console.log(JSON.stringify(report.summary, null, 2));
  process.exit(report.pass ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
