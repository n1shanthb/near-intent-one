/**
 * Multichain paper-trading / shadow engine.
 * Uses live dry quotes for signal simulation. Funded autonomous execution HARD-DISABLED.
 */
import { productionDryQuote } from "./intents.mjs";
import { evaluateLiveMinOutAgainstPolicy } from "./quotePath.mjs";
import { mainnetExecutionGates } from "./safetyGates.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const PAPER_DEFAULT_LIMITS = Object.freeze({
  max_trade_usdc: 1,
  daily_notional_usdc: 5,
  daily_loss_usdc: 1,
  min_net_edge_bps: 5,
  max_slippage_bps: 50,
  quote_max_age_ms: 60_000,
  kill_switch: false,
  funded_execution: false,
});

export function paperStoreDir(env = process.env) {
  return (
    env.NIO_PAPER_STORE_DIR ||
    join(homedir(), ".nio-secure", "mainnet-paper")
  );
}

export function createPaperState(limits = PAPER_DEFAULT_LIMITS) {
  return {
    version: 1,
    created_at: new Date().toISOString(),
    limits: { ...PAPER_DEFAULT_LIMITS, ...limits, funded_execution: false },
    kill_switch: Boolean(limits.kill_switch),
    daily: {
      day: new Date().toISOString().slice(0, 10),
      notional_usdc: 0,
      realized_pnl_usdc: 0,
      trades: 0,
      rejects: 0,
    },
    audit: [],
  };
}

function rollDay(state) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.daily.day !== today) {
    state.daily = {
      day: today,
      notional_usdc: 0,
      realized_pnl_usdc: 0,
      trades: 0,
      rejects: 0,
    };
  }
  return state;
}

export function assertPaperFundedDisabled(env = process.env) {
  const gates = mainnetExecutionGates(env);
  if (gates.autonomous_execution_enabled) {
    return { ok: false, reason: "autonomous_execution_must_stay_false" };
  }
  if (gates.mainnet_broadcast_enabled && env.NIO_PAPER_ALLOW_BROADCAST === "1") {
    return { ok: false, reason: "paper_must_not_enable_broadcast" };
  }
  return { ok: true, gates };
}

/**
 * Net edge after estimated gas + refund/withdraw fees (USDC units).
 */
export function computeNetEdgeUsdc({
  amountInUsdc,
  amountOutUsdc,
  gasUsd = 0,
  refundFeeUsdc = 0,
  withdrawFeeUsdc = 0,
  solverFeeUsdc = 0,
}) {
  const gross = Number(amountOutUsdc) - Number(amountInUsdc);
  const costs =
    Number(gasUsd) +
    Number(refundFeeUsdc) +
    Number(withdrawFeeUsdc) +
    Number(solverFeeUsdc);
  const net = gross - costs;
  const edgeBps = (net / Number(amountInUsdc)) * 10_000;
  return { gross_usdc: gross, costs_usdc: costs, net_usdc: net, edge_bps: edgeBps };
}

export function evaluatePaperSignal(candidate, state, limits = PAPER_DEFAULT_LIMITS) {
  rollDay(state);
  const reasons = [];
  if (state.kill_switch || limits.kill_switch) reasons.push("kill_switch");
  if (limits.funded_execution === true) reasons.push("funded_execution_forbidden_in_paper");
  if (Number(candidate.amount_usdc) > Number(limits.max_trade_usdc)) {
    reasons.push("exceeds_max_trade");
  }
  if (
    state.daily.notional_usdc + Number(candidate.amount_usdc) >
    Number(limits.daily_notional_usdc)
  ) {
    reasons.push("exceeds_daily_notional");
  }
  if (state.daily.realized_pnl_usdc <= -Number(limits.daily_loss_usdc)) {
    reasons.push("daily_loss_limit_hit");
  }
  if (candidate.policy_fit !== "PASS") reasons.push("policy_floor_fail");
  if (Number(candidate.edge_bps) < Number(limits.min_net_edge_bps)) {
    reasons.push("edge_below_min");
  }
  if (candidate.quote_age_ms != null && candidate.quote_age_ms > limits.quote_max_age_ms) {
    reasons.push("quote_stale");
  }
  if (!candidate.route_allowlisted) reasons.push("route_not_allowlisted");
  return {
    ok: reasons.length === 0,
    action: reasons.length === 0 ? "PAPER_TAKE" : "PAPER_SKIP",
    reasons,
  };
}

export function recordPaperTrade(state, { candidate, decision, storeDir = null }) {
  rollDay(state);
  const entry = {
    at: new Date().toISOString(),
    decision: decision.action,
    reasons: decision.reasons,
    route: candidate.route_id,
    amount_usdc: candidate.amount_usdc,
    net_usdc: candidate.net_usdc,
    edge_bps: candidate.edge_bps,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          route: candidate.route_id,
          amount: candidate.amount_usdc,
          min_out: candidate.min_out,
          at: candidate.quoted_at,
        })
      )
      .digest("hex")
      .slice(0, 16),
  };
  state.audit.push(entry);
  if (decision.ok) {
    state.daily.trades += 1;
    state.daily.notional_usdc += Number(candidate.amount_usdc);
    state.daily.realized_pnl_usdc += Number(candidate.net_usdc || 0);
  } else {
    state.daily.rejects += 1;
  }
  if (storeDir) {
    mkdirSync(storeDir, { recursive: true });
    const logPath = join(storeDir, "paper-audit.jsonl");
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
    writeFileSync(join(storeDir, "paper-state.json"), JSON.stringify(state, null, 2));
  }
  return { ok: true, entry, state };
}

export function engageKillSwitch(state, reason = "owner") {
  state.kill_switch = true;
  state.audit.push({
    at: new Date().toISOString(),
    decision: "KILL_SWITCH",
    reasons: [reason],
  });
  return state;
}

/**
 * Shadow one allowlisted route with a live dry quote (no broadcast).
 */
export async function shadowQuoteRoute({
  routeId,
  assetIn,
  assetOut,
  amount = "1000000",
  recipient,
  refundTo,
  slipBps = 50,
  gasUsd = 0,
  routeAllowlisted = true,
  quoteFn = productionDryQuote,
  state = null,
  limits = PAPER_DEFAULT_LIMITS,
  env = process.env,
} = {}) {
  const fundedGate = assertPaperFundedDisabled(env);
  if (!fundedGate.ok) return fundedGate;

  const paperState = state || createPaperState(limits);
  const quotedAt = Date.now();
  const quote = await quoteFn({
    originAsset: assetIn,
    destinationAsset: assetOut,
    amount,
    recipient,
    refundTo,
    slippageTolerance: slipBps,
  });
  if (!quote.ok) {
    return { ok: false, reason: "quote_failed", detail: quote.reason || quote.status };
  }
  const amountInUsdc = Number(amount) / 1e6;
  const amountOut = Number(quote.amount_out || quote.quote?.amountOut || 0) / 1e6;
  const minOut = quote.min_amount_out || quote.quote?.minAmountOut || "0";
  const refundFee = Number(quote.quote?.refundFee || 0) / 1e6;
  const withdrawFee = Number(quote.quote?.withdrawFee || 0) / 1e6;
  const edge = computeNetEdgeUsdc({
    amountInUsdc,
    amountOutUsdc: amountOut,
    gasUsd,
    refundFeeUsdc: 0, // refund fee only on failure path — exclude from happy-path edge
    withdrawFeeUsdc: withdrawFee,
  });
  const policy = evaluateLiveMinOutAgainstPolicy({
    amountIn: amount,
    minAmountOut: minOut,
    maxSlippageBps: 100,
    label: routeId,
  });
  const candidate = {
    route_id: routeId,
    amount_usdc: amountInUsdc,
    amount_out_usdc: amountOut,
    min_out: minOut,
    net_usdc: edge.net_usdc,
    edge_bps: edge.edge_bps,
    policy_fit: policy.result,
    quote_age_ms: Date.now() - quotedAt,
    quoted_at: new Date(quotedAt).toISOString(),
    route_allowlisted: routeAllowlisted,
    refund_fee_usdc: refundFee,
    withdraw_fee_usdc: withdrawFee,
    gas_usd: gasUsd,
  };
  const decision = evaluatePaperSignal(candidate, paperState, limits);
  return {
    ok: true,
    mode: "paper",
    funded_execution: false,
    candidate,
    decision,
    edge,
    policy,
    quote_ok: true,
  };
}

export function loadOrCreatePaperState(storeDir = paperStoreDir()) {
  mkdirSync(storeDir, { recursive: true });
  const path = join(storeDir, "paper-state.json");
  if (existsSync(path)) {
    return { path, state: JSON.parse(readFileSync(path, "utf8")) };
  }
  const state = createPaperState();
  writeFileSync(path, JSON.stringify(state, null, 2));
  return { path, state };
}
