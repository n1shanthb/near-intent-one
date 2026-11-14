/**
 * Autonomous execution adapter — bridges keeper decisions to M1/M2 hardened libs.
 *
 * CRITICAL: executable amount/route MUST come from the final accepted Fitter
 * proposal only — never the raw Strategist proposal.
 *
 * Modes: SHADOW | TESTNET | MAINNET (MAINNET hard-stopped in J14)
 */

import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { isAmbiguousOutcome } from "../mainnet/mission1Safety.mjs";
import { openTxJournal, TX_STATE } from "../execution/txJournal.mjs";
import { ACTION, LLM_MODE } from "./shadowAgent.mjs";

export const EXEC_MODE = Object.freeze({
  SHADOW: "SHADOW",
  TESTNET: "TESTNET",
  LOCAL_FORK: "LOCAL_FORK",
  MAINNET: "MAINNET",
});

/**
 * Extract the sole executable size from a fitter-accepted decision.
 * Rejects strategist-only sizes.
 */
export function extractFitterBoundAmount(decision) {
  const fitter = decision?.fitter || decision?.evidence?.fitter_after_critic || null;
  const outcome = fitter?.outcome;
  if (outcome !== "ALLOWED" && outcome !== "ADAPTED") {
    return {
      ok: false,
      blockers: [`fitter_outcome_not_executable:${outcome || "missing"}`],
    };
  }
  const fitted = fitter?.fitted_size_raw;
  if (fitted === undefined || fitted === null || fitted === "") {
    return { ok: false, blockers: ["fitter_fitted_size_raw_required"] };
  }
  if (!/^\d+$/.test(String(fitted))) {
    return { ok: false, blockers: ["fitter_fitted_size_not_digit_string"] };
  }
  if (BigInt(fitted) <= 0n) {
    return { ok: false, blockers: ["fitter_fitted_size_non_positive"] };
  }

  // Refuse if caller tried to prefer strategist size (defense in depth)
  const strategistRaw =
    decision?.strategy?.proposed_size_usdc_raw ||
    decision?.evidence?.strategist?.proposal?.proposed_size_usdc_raw;
  if (
    strategistRaw !== undefined &&
    String(strategistRaw) !== String(fitted) &&
    outcome === "ADAPTED"
  ) {
    // OK — adapted by design; executable MUST be fitted, not strategist
  }
  if (
    decision?.force_amount_raw &&
    String(decision.force_amount_raw) !== String(fitted)
  ) {
    return {
      ok: false,
      blockers: ["force_amount_diverges_from_fitter"],
    };
  }

  return {
    ok: true,
    amount_raw: String(fitted),
    fitter_outcome: outcome,
    parameters_changed: fitter.parameters_changed || [],
    operation_id: fitter.operation_id || null,
  };
}

/**
 * Revalidate decision fields against on-chain mandate snapshot.
 */
export function revalidateAgainstChain({ decision, fitterAmount, onChain, quote }) {
  const blockers = [];
  if (!onChain) {
    blockers.push("on_chain_snapshot_required");
    return { ok: false, blockers };
  }
  if (onChain.paused) blockers.push("on_chain_paused");
  if (onChain.revoked) blockers.push("on_chain_revoked");
  if (onChain.enforce_autonomous_on_agent && !onChain.autonomous_trading) {
    blockers.push("autonomous_trading_required");
  }

  const decisionEpoch = decision?.mandate_epoch ?? decision?.evidence?.mandate_epoch;
  if (
    decisionEpoch !== undefined &&
    onChain.mandate_epoch !== undefined &&
    Number(decisionEpoch) !== Number(onChain.mandate_epoch)
  ) {
    blockers.push(
      `epoch_mismatch:decision=${decisionEpoch},chain=${onChain.mandate_epoch}`
    );
  }

  const maxTrade = BigInt(onChain.limits?.max_trade_value || onChain.max_trade_raw || "0");
  if (maxTrade > 0n && BigInt(fitterAmount.amount_raw) > maxTrade) {
    blockers.push("fitted_exceeds_on_chain_max_trade");
  }

  if (quote) {
    if (quote.stale || quote.expired) blockers.push("quote_stale_or_expired");
    if (quote.amount_in && String(quote.amount_in) !== String(fitterAmount.amount_raw)) {
      blockers.push("quote_amount_in_mismatch_fitter");
    }
    if (
      decision?.committed_destination &&
      quote.destination &&
      String(quote.destination).toLowerCase() !==
        String(decision.committed_destination).toLowerCase()
    ) {
      blockers.push("quote_destination_mismatch");
    }
    if (
      decision?.committed_asset_in &&
      quote.asset_in &&
      String(quote.asset_in) !== String(decision.committed_asset_in)
    ) {
      blockers.push("quote_asset_in_mismatch");
    }
  }

  return { ok: blockers.length === 0, blockers };
}

/**
 * Map keeper decision → execution plan (no side effects).
 */
export function planAutonomousExecution({
  decision,
  mandate,
  onChain,
  quote = null,
  mode = EXEC_MODE.SHADOW,
}) {
  assert(decision, "decision_required");
  const blockers = [];

  if (mode === EXEC_MODE.MAINNET) {
    blockers.push("mainnet_exec_hard_stopped_in_j14");
  }
  if (onChain?.paused) blockers.push("on_chain_paused");
  if (onChain?.revoked) blockers.push("on_chain_revoked");
  if (onChain?.enforce_autonomous_on_agent && !onChain?.autonomous_trading) {
    blockers.push("autonomous_trading_required");
  }
  if (!mandate?.trading_enabled) blockers.push("mandate_trading_disabled");

  if (decision.action !== ACTION.TRADE && decision.action !== "TRADE") {
    return {
      ok: true,
      execute: false,
      reason: decision.reason || "ai_no_trade",
      labeled_autonomous_ai: decision.llm_mode === LLM_MODE.LIVE_LLM,
      decision_hash: decision.decision_hash,
      note: "NO_TRADE/HOLD recorded as correct; do not force execution",
    };
  }

  if (decision.llm_mode !== LLM_MODE.LIVE_LLM && !decision.deterministic_scenario) {
    blockers.push("trade_without_live_llm_must_be_labeled_deterministic_scenario");
  }

  const fitterAmount = extractFitterBoundAmount(decision);
  if (!fitterAmount.ok) {
    blockers.push(...fitterAmount.blockers);
  } else {
    // Explicitly refuse using strategist size when it differs
    const strat =
      decision?.strategy?.proposed_size_usdc_raw ||
      decision?.evidence?.strategist?.proposal?.proposed_size_usdc_raw;
    if (strat && String(strat) !== String(fitterAmount.amount_raw)) {
      // Still OK to execute fitted — record binding
      decision = {
        ...decision,
        _execution_binding: {
          rejected_strategist_size: String(strat),
          accepted_fitter_size: fitterAmount.amount_raw,
        },
      };
    }
  }

  if (fitterAmount.ok) {
    const chainCheck = revalidateAgainstChain({
      decision,
      fitterAmount,
      onChain,
      quote,
    });
    if (!chainCheck.ok) blockers.push(...chainCheck.blockers);
  }

  if (blockers.length) {
    return {
      ok: false,
      execute: false,
      blockers,
      decision_hash: decision.decision_hash,
      fitter_binding: fitterAmount.ok
        ? {
            amount_raw: fitterAmount.amount_raw,
            outcome: fitterAmount.fitter_outcome,
          }
        : null,
    };
  }

  return {
    ok: true,
    execute: true,
    mode,
    requires_owner_ledger_per_trade: false,
    requires_contract_agent_sign: true,
    requires_independent_reconcile: true,
    amount_raw: fitterAmount.amount_raw,
    fitter_outcome: fitterAmount.fitter_outcome,
    fitter_operation_id: fitterAmount.operation_id,
    execution_binding: {
      source: "fitter_fitted_size_raw_only",
      amount_raw: fitterAmount.amount_raw,
      rejected_strategist_size:
        decision?.strategy?.proposed_size_usdc_raw &&
        String(decision.strategy.proposed_size_usdc_raw) !==
          String(fitterAmount.amount_raw)
          ? String(decision.strategy.proposed_size_usdc_raw)
          : null,
    },
    decision_hash: decision.decision_hash,
    mandate_hash: decision.mandate_hash,
    mandate_epoch: onChain?.mandate_epoch ?? null,
    steps: [
      "read_on_chain_policy",
      "fresh_quote",
      "attest_quote",
      "propose_bounded_op",
      "request_signature_1_yocto",
      "persist_signed_raw_and_nonce",
      "broadcast_exactly_once",
      "verify_settlement_independent",
      "reconcile_restricted",
    ],
  };
}

function requireJournalSecret({ allowShadowFallback = false, operationId }) {
  const fromEnv = process.env.NIO_TX_JOURNAL_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  const path = process.env.NIO_TX_JOURNAL_SECRET_PATH;
  if (path && existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length >= 32) return raw;
  }
  if (allowShadowFallback) {
    // Shadow/sim only — never for TESTNET/MAINNET financial persistence
    return createHash("sha256")
      .update(`shadow-only-not-for-finance:${operationId}`)
      .digest("hex");
  }
  const err = new Error("NIO_TX_JOURNAL_SECRET_required_for_financial_execution");
  err.code = "JOURNAL_SECRET_REQUIRED";
  throw err;
}

/**
 * Persist intent before any broadcast. Financial modes fail closed without secret.
 */
export async function persistPreBroadcast({
  journalPath,
  operationId,
  signedRaw,
  nonce,
  decisionHash,
  network,
  mode = EXEC_MODE.SHADOW,
}) {
  assert(operationId, "operation_id_required");
  assert(signedRaw, "signed_raw_required");
  assert(nonce !== undefined && nonce !== null, "nonce_required");

  const secret = requireJournalSecret({
    allowShadowFallback: mode === EXEC_MODE.SHADOW,
    operationId,
  });
  const journal = openTxJournal({ path: journalPath, secret });
  const localHash = createHash("sha256").update(String(signedRaw)).digest("hex");
  if (typeof journal.insertDraft === "function") {
    journal.insertDraft({
      id: operationId,
      portfolio_id: `autonomous-${network || "shadow"}`,
      idempotency_key: `prebroadcast:${operationId}:${localHash.slice(0, 16)}`,
      nonce: String(nonce),
      chain_id: network || "testnet",
      meta: { decision_hash: decisionHash, nonce: String(nonce) },
    });
  }
  if (typeof journal.markSigned === "function") {
    // signedRaw must be hex (0x-optional); non-hex callers must encode first
    const hex = String(signedRaw).startsWith("0x")
      ? String(signedRaw)
      : /^[0-9a-fA-F]+$/.test(String(signedRaw))
        ? String(signedRaw)
        : Buffer.from(String(signedRaw), "utf8").toString("hex");
    journal.markSigned(operationId, {
      signedRawHex: hex,
      meta: { nonce: String(nonce), local_tx_hash: localHash },
    });
  }

  return {
    ok: true,
    operation_id: operationId,
    local_tx_hash: localHash,
    state: TX_STATE.SIGNED,
    note: "Persisted before broadcast; restart must not re-sign",
  };
}

/**
 * Broadcast policy: at most once; ambiguous RPC → UNKNOWN, never blind retry.
 */
export function evaluateBroadcastAttempt({ priorState, rpcResult, transportError }) {
  if (priorState === TX_STATE.BROADCAST || priorState === TX_STATE.CONFIRMED) {
    return {
      ok: false,
      action: "REFUSE_RETRY",
      reason: "already_broadcast",
      may_retry_broadcast: false,
      may_resign: false,
    };
  }
  if (transportError && !rpcResult?.tx_hash) {
    if (isAmbiguousOutcome(String(transportError))) {
      return {
        ok: false,
        action: "UNKNOWN_QUARANTINE",
        reason: "ambiguous_transport",
        may_retry_broadcast: false,
        may_resign: false,
      };
    }
    return {
      ok: false,
      action: "RETRY_IDENTICAL_SIGNED_ONLY",
      reason: "transport_before_accept",
      may_retry_broadcast: true,
      may_resign: false,
    };
  }
  if (rpcResult?.tx_hash) {
    return {
      ok: true,
      action: "MARK_BROADCAST",
      tx_hash: rpcResult.tx_hash,
      may_retry_broadcast: false,
      may_resign: false,
    };
  }
  return {
    ok: false,
    action: "UNKNOWN_QUARANTINE",
    reason: "missing_rpc_response",
    may_retry_broadcast: false,
    may_resign: false,
  };
}

export function listOwnerApprovalDependencies() {
  return [
    {
      id: "wasm_upgrade",
      required_once: true,
      actor: "owner_Ledger_or_temp_deploy_key",
      per_trade: false,
      note: "Separate from mandate activation",
    },
    {
      id: "mandate_activation",
      required_once: true,
      actor: "owner_Ledger",
      method: "activate_autonomous_mandate",
      per_trade: false,
    },
    {
      id: "unpause",
      required_once: true,
      actor: "owner_Ledger",
      method: "unpause",
      per_trade: false,
      note: "Separate signature when unpause_now=false",
    },
    {
      id: "propose",
      actor: "agent_ops",
      per_trade: true,
      autonomous: "bypass_operator_confirm_when_mandate_active",
    },
    {
      id: "request_signature",
      actor: "agent_ops",
      per_trade: true,
      autonomous: "bypass_operator_confirm_when_mandate_active",
    },
    {
      id: "broadcast",
      actor: "agent_ops_or_keeper",
      per_trade: true,
      autonomous: "bypass_operator_confirm_when_mandate_active",
    },
    {
      id: "reconcile",
      actor: "reconciler_or_owner",
      per_trade: true,
      autonomous: "NEVER_bypass — independent verified evidence only",
    },
  ];
}

export async function executeShadowPlan(plan, { appendJournal }) {
  if (!plan.execute) {
    await appendJournal?.({
      kind: "exec_skip",
      reason: plan.reason || plan.blockers,
      decision_hash: plan.decision_hash,
    });
    return { ok: true, executed: false, plan };
  }
  const record = {
    kind: "trade",
    action: "SHADOW_AUTONOMOUS_SIM",
    outcome: "SIMULATED_OK",
    amount_raw: plan.amount_raw,
    fitter_outcome: plan.fitter_outcome,
    execution_binding: plan.execution_binding,
    decision_hash: plan.decision_hash,
    requires_owner_ledger_per_trade: false,
    shadow: true,
  };
  await appendJournal?.(record);
  return { ok: true, executed: true, shadow: true, record };
}
