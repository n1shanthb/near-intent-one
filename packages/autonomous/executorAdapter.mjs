/**
 * Autonomous execution adapter — bridges J12 keeper decisions to M1/M2 hardened libs.
 *
 * Modes:
 *   SHADOW — simulate only (default)
 *   TESTNET — real NEAR txs against disposable policy (when wired)
 *   MAINNET — blocked unless explicit owner-approved flags (never auto)
 *
 * Inside an activated autonomous mandate, per-trade owner Ledger confirmation
 * is NOT required. Contract authority (pause/revoke/limits/agent identity) still binds.
 * Reconcile still requires restricted reconciler / independent verification — never faked.
 */

import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { isAmbiguousOutcome } from "../mainnet/mission1Safety.mjs";
import { openTxJournal, TX_STATE } from "../execution/txJournal.mjs";
import { ACTION, LLM_MODE } from "./shadowAgent.mjs";

export const EXEC_MODE = Object.freeze({
  SHADOW: "SHADOW",
  TESTNET: "TESTNET",
  MAINNET: "MAINNET",
});

/**
 * Map keeper decision → execution plan (no side effects).
 */
export function planAutonomousExecution({ decision, mandate, onChain, mode = EXEC_MODE.SHADOW }) {
  assert(decision, "decision_required");
  const blockers = [];

  if (mode === EXEC_MODE.MAINNET) {
    blockers.push("mainnet_exec_hard_stopped_in_j13");
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

  const amount = String(
    decision.strategy?.proposed_size_usdc_raw ||
      decision.fitter?.fitted_size_raw ||
      "0"
  );
  if (BigInt(amount || "0") <= 0n) blockers.push("non_positive_size");

  if (blockers.length) {
    return {
      ok: false,
      execute: false,
      blockers,
      decision_hash: decision.decision_hash,
    };
  }

  return {
    ok: true,
    execute: true,
    mode,
    requires_owner_ledger_per_trade: false,
    requires_contract_agent_sign: true,
    requires_independent_reconcile: true,
    amount_raw: amount,
    decision_hash: decision.decision_hash,
    mandate_hash: decision.mandate_hash,
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

/**
 * Persist intent before any broadcast. Returns journal handle + op id.
 */
export async function persistPreBroadcast({
  journalPath,
  operationId,
  signedRaw,
  nonce,
  decisionHash,
  network,
}) {
  assert(operationId, "operation_id_required");
  assert(signedRaw, "signed_raw_required");
  assert(nonce !== undefined && nonce !== null, "nonce_required");

  const secret =
    process.env.NIO_TX_JOURNAL_SECRET ||
    createHash("sha256").update(`j13-shadow-${operationId}`).digest("hex");
  const journal = openTxJournal({ path: journalPath, secret });
  const localHash = createHash("sha256").update(String(signedRaw)).digest("hex");
  if (typeof journal.insertDraft === "function") {
    journal.insertDraft({
      id: operationId,
      network: network || "testnet",
      meta: { decision_hash: decisionHash, nonce: String(nonce) },
    });
  }
  if (typeof journal.markSigned === "function") {
    journal.markSigned(operationId, {
      signedRawHex: String(signedRaw),
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
    // Clear failure before accept — may retry same signed bytes once from journal only
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

/**
 * Owner-approval dependencies that supervised M1/M2 scripts still encode.
 * Autonomous path must call library primitives, not interactive CLIs.
 */
export function listOwnerApprovalDependencies() {
  return [
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
      note: "Prefer separate from activate for first mainnet",
    },
    {
      id: "propose",
      required_once: false,
      actor: "agent_ops",
      per_trade: true,
      supervised_script_gate: "requireOperatorConfirmation(propose)",
      autonomous: "bypass_operator_confirm_when_mandate_active",
    },
    {
      id: "request_signature",
      required_once: false,
      actor: "agent_ops",
      per_trade: true,
      supervised_script_gate: "requireOperatorConfirmation(sign)",
      autonomous: "bypass_operator_confirm_when_mandate_active",
    },
    {
      id: "broadcast",
      required_once: false,
      actor: "agent_ops_or_keeper",
      per_trade: true,
      supervised_script_gate: "requireOperatorConfirmation(broadcast)",
      autonomous: "bypass_operator_confirm_when_mandate_active",
    },
    {
      id: "reconcile",
      required_once: false,
      actor: "reconciler_or_owner",
      per_trade: true,
      supervised_script_gate: "requireOperatorConfirmation(reconcile)",
      autonomous: "NEVER_bypass — independent verified evidence only",
    },
  ];
}

/**
 * Run shadow execution record for a TRADE plan (deterministic test scenarios).
 */
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
    decision_hash: plan.decision_hash,
    requires_owner_ledger_per_trade: false,
    shadow: true,
  };
  await appendJournal?.(record);
  return { ok: true, executed: true, shadow: true, record };
}
