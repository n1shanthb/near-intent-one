/**
 * Gate K pipeline:
 * Gate J AI decision → Gate K safety overlay → economic buffer →
 * fresh quote → mandate revalidation → (optional) Gate I execute.
 *
 * Modes:
 *   AI_DRY_RUN — never signs (default)
 *   AI_TESTNET_EXECUTION — requires operator confirm + auth; at most one first test
 *   AI_AUTONOMOUS — separate owner on-chain switch; never auto-starts
 */
import { runGateJPipeline } from "../gate-j/pipeline.mjs";
import { revalidateMandate } from "../gate-j/hydrate.mjs";
import { applyGateKSafety, assertSingleFlight } from "./safety.mjs";
import { assessEconomicViability } from "./economics.mjs";
import { fetchFreshExecutableQuote } from "./quote.mjs";
import {
  buildAgentRequest,
  buildExecutionPreview,
  executeGateKTrade,
} from "./execute.mjs";
import { MODE, REASON, FIRST_TEST, DEFAULT_EDGE_BUFFER_BPS } from "./constants.mjs";

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {object} opts
 * @param {object} opts.mandate
 * @param {object} opts.portfolio
 * @param {string} opts.portfolioId
 * @param {object} [opts.balances]
 * @param {boolean} [opts.useLlm=false]
 * @param {string} [opts.mode=AI_DRY_RUN]
 * @param {boolean} [opts.operatorConfirm=false]
 * @param {boolean} [opts.authenticated=false]
 * @param {boolean} [opts.reconcilerOk=false]
 * @param {object} [opts.store]
 * @param {Function} [opts.viewFunction]
 * @param {Function} [opts.quoteFn]
 * @param {object} [opts.executeDeps] — store,getNearAccounts,viewFunction,attestor,eth
 * @param {object} [opts.fixtureProposal]
 * @param {object} [opts.marketFixture]
 * @param {string} [opts.criticFixture]
 * @param {number} [opts.edgeBufferBps]
 */
export async function runGateKPipeline(opts) {
  const {
    mandate,
    portfolio,
    portfolioId,
    balances = {},
    useLlm = false,
    mode = MODE.DRY_RUN,
    operatorConfirm = false,
    authenticated = false,
    reconcilerOk = false,
    store = null,
    viewFunction = null,
    quoteFn = null,
    executeDeps = null,
    fixtureProposal = null,
    marketFixture = null,
    criticFixture = null,
    edgeBufferBps = DEFAULT_EDGE_BUFFER_BPS,
    forecast = null,
  } = opts;

  const trace = {
    gate: "K",
    mode,
    network: "sepolia_testnet_only",
    started_at: nowIso(),
    portfolio_id: portfolioId,
    signing: false,
    broadcast: false,
  };

  // Autonomous mode requires on-chain autonomous_trading === true
  if (mode === MODE.AUTONOMOUS) {
    if (mandate?.autonomous_trading !== true) {
      trace.enforcement = {
        decision: "NO_TRADE",
        reason_codes: [REASON.AUTONOMOUS_DISABLED],
        may_sign: false,
      };
      trace.finished_at = nowIso();
      return trace;
    }
  }

  // Single-flight / max trades for any path that might execute
  if (mode !== MODE.DRY_RUN && store) {
    const sf = assertSingleFlight({ store, portfolioId });
    if (!sf.ok) {
      trace.single_flight = sf;
      trace.enforcement = {
        decision: "NO_TRADE",
        reason_codes: [sf.reason],
        may_sign: false,
      };
      trace.finished_at = nowIso();
      return trace;
    }
    trace.single_flight = sf;
  }

  // 1) Gate J decision pipeline (always dry at Gate J layer)
  const j = await runGateJPipeline({
    mandate,
    balances,
    fixtureProposal,
    marketFixture,
    criticFixture: useLlm ? null : criticFixture,
    useLlm,
    dryRun: true,
    allowExecute: false,
    forecast,
  });
  trace.gate_j = {
    researcher: j.researcher,
    strategist: j.strategist,
    fitter: j.fitter_after_critic || j.fitter,
    critic: j.critic,
    enforcement: j.enforcement,
    market: j.market,
    summary: j.summary,
    spend: j.spend,
  };

  // Gate J dry-run yields EXECUTE_DRY_RUN (may_sign false). Qualifying when
  // fitter ALLOWED/ADAPTED with TRADE fitted proposal and enforcement not blocked.
  const jDecision = j.enforcement?.decision;
  const fitOutcome = j.fitter_after_critic || j.fitter;
  const jQualifies =
    (jDecision === "EXECUTE_DRY_RUN" ||
      jDecision === "EXECUTE" ||
      jDecision === "TRADE") &&
    fitOutcome?.outcome !== "REJECTED" &&
    fitOutcome?.fitted_proposal?.choice === "TRADE";

  if (!jQualifies) {
    trace.enforcement = {
      decision: "NO_TRADE",
      reason_codes: j.enforcement?.reason_codes || ["GATE_J_BLOCKED"],
      may_sign: false,
      inherited_from: "gate_j",
      gate_j_decision: jDecision || null,
    };
    trace.finished_at = nowIso();
    return trace;
  }

  const fitted =
    (j.fitter_after_critic || j.fitter)?.fitted_proposal ||
    j.enforcement?.fitted_proposal ||
    j.strategist?.proposal;

  // 2) Gate K safety overlay (≤26 USDC first test, pair, portfolio)
  const safety = applyGateKSafety({
    mandate,
    fittedProposal: fitted,
    portfolioId,
  });
  trace.safety = safety;
  if (!safety.ok) {
    trace.enforcement = {
      decision: "NO_TRADE",
      reason_codes: [safety.reason || REASON.SAFETY_LIMIT],
      may_sign: false,
    };
    trace.finished_at = nowIso();
    return trace;
  }

  // 3) Economic viability with buffer (preserve Gate J rejection of thin edge)
  const market = j.market || {};
  const strat = j.strategist?.proposal || {};
  const edgeBps =
    Number(fitted?.expected_benefit?.edge_bps) ||
    Number(strat.expected_benefit?.edge_bps) ||
    Number(fitted?.expected_edge_bps) ||
    0;
  const feeBps =
    Number(fitted?.estimated_costs?.fee_bps) ||
    Number(strat.estimated_costs?.fee_bps) ||
    Number(market.fee_bps) ||
    Number(process.env.GATE_K_FEE_BPS || 30);
  const impactBps =
    Number(fitted?.estimated_costs?.price_impact_bps) ||
    Number(strat.estimated_costs?.price_impact_bps) ||
    Number(market.price_impact_bps) ||
    5;

  const economic = assessEconomicViability({
    edge_bps: edgeBps,
    fee_bps: feeBps,
    price_impact_bps: impactBps,
    buffer_bps: edgeBufferBps,
    amount_in: safety.safe_proposal.proposed_size_usdc_raw,
  });
  trace.economics = economic;
  if (!economic.ok) {
    trace.enforcement = {
      decision: "NO_TRADE",
      reason_codes: [economic.reason || "ECONOMIC_NOT_VIABLE", REASON.EDGE_BUFFER],
      may_sign: false,
    };
    trace.finished_at = nowIso();
    return trace;
  }

  // 4) Fresh executable quote + liquidity re-check
  let quoteResult = { ok: false, reason: REASON.NO_FRESH_QUOTE };
  if (quoteFn) {
    quoteResult = await fetchFreshExecutableQuote({
      amountRaw: safety.safe_proposal.proposed_size_usdc_raw,
      quoteFn,
    });
  } else if (mode === MODE.DRY_RUN) {
    quoteResult = {
      ok: true,
      quote: {
        quote_hash: "dry-run-no-quote",
        amount_out: "1",
        note: "dry_run_skipped_live_quote",
      },
      dry_skipped: true,
    };
  }
  trace.quote = quoteResult;
  if (!quoteResult.ok) {
    trace.enforcement = {
      decision: "NO_TRADE",
      reason_codes: [quoteResult.reason || REASON.NO_FRESH_QUOTE],
      may_sign: false,
    };
    trace.finished_at = nowIso();
    return trace;
  }

  const economicQuoted = assessEconomicViability({
    edge_bps: edgeBps,
    fee_bps: feeBps,
    price_impact_bps: impactBps,
    buffer_bps: edgeBufferBps,
    amount_in: safety.safe_proposal.proposed_size_usdc_raw,
    amount_out: quoteResult.quote?.amount_out,
  });
  trace.economics_quoted = economicQuoted;
  if (!economicQuoted.ok) {
    trace.enforcement = {
      decision: "NO_TRADE",
      reason_codes: [economicQuoted.reason || "ECONOMIC_NOT_VIABLE"],
      may_sign: false,
    };
    trace.finished_at = nowIso();
    return trace;
  }

  // 5) Revalidate on-chain mandate
  let revalidation = { ok: true, skipped: !viewFunction };
  if (viewFunction && portfolio) {
    revalidation = await revalidateMandate({
      view: (accountId, method, args) => viewFunction(accountId, method, args),
      portfolio,
      balance_usdc_raw: mandate.balance_usdc_raw,
      expected_revalidate_key: mandate.revalidate_key,
    });
  }
  trace.revalidation = revalidation;
  if (!revalidation.ok) {
    trace.enforcement = {
      decision: "NO_TRADE",
      reason_codes: [revalidation.reason || REASON.POLICY_CHANGED],
      may_sign: false,
    };
    trace.finished_at = nowIso();
    return trace;
  }

  const preview = buildExecutionPreview({
    portfolio,
    mandate,
    safeProposal: safety.safe_proposal,
    quote: quoteResult.quote,
    economic,
    mode,
  });
  trace.preview = preview;

  // Dry run stops here
  if (mode === MODE.DRY_RUN) {
    trace.enforcement = {
      decision: "TRADE",
      reason_codes: ["DRY_RUN_OK"],
      may_sign: false,
      note: "qualifying_trade_preview_only",
    };
    trace.finished_at = nowIso();
    return trace;
  }

  // Execution modes require auth + operator confirm (first test) or autonomous flag
  if (!authenticated) {
    trace.enforcement = {
      decision: "NO_TRADE",
      reason_codes: [REASON.UNAUTHENTICATED],
      may_sign: false,
    };
    trace.finished_at = nowIso();
    return trace;
  }

  if (mode === MODE.TESTNET_EXECUTION && !operatorConfirm) {
    trace.enforcement = {
      decision: "TRADE",
      reason_codes: [REASON.OPERATOR_CONFIRM_REQUIRED],
      may_sign: false,
      awaiting_operator: true,
    };
    trace.finished_at = nowIso();
    return trace;
  }

  if (mode === MODE.AUTONOMOUS && mandate.autonomous_trading !== true) {
    trace.enforcement = {
      decision: "NO_TRADE",
      reason_codes: [REASON.AUTONOMOUS_DISABLED],
      may_sign: false,
    };
    trace.finished_at = nowIso();
    return trace;
  }

  if (!reconcilerOk) {
    trace.enforcement = {
      decision: "NO_TRADE",
      reason_codes: [REASON.RECONCILER_DOWN],
      may_sign: false,
    };
    trace.finished_at = nowIso();
    return trace;
  }

  if (!executeDeps) {
    trace.enforcement = {
      decision: "NO_TRADE",
      reason_codes: [REASON.EXECUTION_DISABLED],
      may_sign: false,
      note: "execute_deps_missing",
    };
    trace.finished_at = nowIso();
    return trace;
  }

  // Hard stop unless GATE_K_ALLOW_SIGN=1 (operator must set after explicit approval)
  if (process.env.GATE_K_ALLOW_SIGN !== "1") {
    trace.enforcement = {
      decision: "TRADE",
      reason_codes: ["SIGNING_GATED_AWAITING_OPERATOR"],
      may_sign: false,
      preview,
      note: "Set GATE_K_ALLOW_SIGN=1 only after explicit operator authorization",
    };
    trace.finished_at = nowIso();
    return trace;
  }

  const agentRequest = buildAgentRequest({
    amount: safety.safe_proposal.proposed_size_usdc_raw,
    recipient: portfolio.intents_signer_id,
  });

  const exec = await executeGateKTrade(executeDeps, {
    portfolioId,
    portfolio,
    mandate: revalidation.mandate || mandate,
    safeProposal: {
      ...safety.safe_proposal,
      operation_id: j.summary?.operation_id,
    },
    quote: quoteResult.quote,
    economic,
    agentRequest,
    authenticated,
    reconcilerOk,
    operatorConfirmed: operatorConfirm || mode === MODE.AUTONOMOUS,
    mode,
  });

  trace.execution = exec;
  trace.signing = !!exec.signed;
  trace.enforcement = {
    decision: exec.ok && exec.signed ? "SIGNED_PENDING_BROADCAST" : "NO_TRADE",
    reason_codes: exec.ok ? ["SIGNED"] : [exec.reason || "EXECUTE_FAILED"],
    may_sign: false,
    signed: !!exec.signed,
  };
  trace.finished_at = nowIso();
  return trace;
}

export { MODE, FIRST_TEST };
