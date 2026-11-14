/**
 * J14 autonomous execution service — non-interactive M1/M2-shaped pipeline.
 * TESTNET/SHADOW only in this milestone. Never treats LLM as authority.
 */
import { strict as assert } from "node:assert";
import {
  planAutonomousExecution,
  persistPreBroadcast,
  evaluateBroadcastAttempt,
  EXEC_MODE,
} from "./executorAdapter.mjs";
import { ACTION, LLM_MODE } from "./shadowAgent.mjs";
import { TX_STATE } from "../execution/txJournal.mjs";

/**
 * Build a clearly labeled deterministic TRADE decision for path tests.
 * Never mislabeled as LIVE_LLM.
 */
export function deterministicTradeScenario({
  strategistSize = "100000000",
  fittedSize = "1000000",
  fitterOutcome = "ADAPTED",
  destination = "intents.near",
  assetIn = "USDC",
  assetOut = "NEAR",
  mandateEpoch = 2,
} = {}) {
  return {
    action: ACTION.TRADE,
    llm_mode: LLM_MODE.FIXTURE,
    deterministic_scenario: true,
    reason: "DETERMINISTIC_EXEC_PATH_TEST",
    decision_hash: `det-${fittedSize}-${mandateEpoch}`,
    mandate_hash: "deterministic-mandate",
    mandate_epoch: mandateEpoch,
    committed_destination: destination,
    committed_asset_in: assetIn,
    strategy: {
      action: ACTION.TRADE,
      proposed_size_usdc_raw: String(strategistSize),
      reasoning: "deterministic_strategist_oversize",
    },
    fitter: {
      outcome: fitterOutcome,
      fitted_size_raw: String(fittedSize),
      parameters_changed:
        String(strategistSize) !== String(fittedSize)
          ? [
              {
                parameter: "proposed_size_usdc_raw",
                from: String(strategistSize),
                to: String(fittedSize),
                why: "SIZE_REDUCED_TO_LIMIT",
              },
            ]
          : [],
      operation_id: `det-op-${fittedSize}`,
      reason_codes: ["SIZE_REDUCED_TO_LIMIT"],
    },
  };
}

/**
 * Run one autonomous execution attempt.
 *
 * @param {object} opts
 * @param {object} opts.decision
 * @param {object} opts.mandate
 * @param {object} opts.onChain — live or fixture chain snapshot
 * @param {object} [opts.quote]
 * @param {string} [opts.mode]
 * @param {object} [opts.adapters] — { propose, requestSignature, broadcast, settle, reconcile, getPending }
 * @param {string} [opts.journalPath]
 * @param {boolean} [opts.simulateBroadcast=true]
 */
export async function runAutonomousExecution(opts) {
  const {
    decision,
    mandate,
    onChain,
    quote = null,
    mode = EXEC_MODE.SHADOW,
    adapters = null,
    journalPath = null,
    simulateBroadcast = true,
  } = opts;

  assert(decision, "decision_required");
  assert(mandate, "mandate_required");
  assert(onChain, "on_chain_required");

  const trace = {
    started_at: new Date().toISOString(),
    mode,
    steps: [],
    ok: false,
  };

  const plan = planAutonomousExecution({
    decision,
    mandate,
    onChain,
    quote,
    mode,
  });
  trace.plan = plan;
  trace.steps.push({ plan: plan.execute ? "EXECUTE" : "SKIP", blockers: plan.blockers });

  if (!plan.execute) {
    trace.ok = plan.ok !== false;
    trace.finished_at = new Date().toISOString();
    return trace;
  }

  if (mode === EXEC_MODE.MAINNET) {
    trace.ok = false;
    trace.error = "mainnet_hard_stopped";
    return trace;
  }

  // Propose
  let proposeResult = null;
  if (adapters?.propose) {
    proposeResult = await adapters.propose({
      amount_raw: plan.amount_raw,
      operation_id: plan.fitter_operation_id || `auto-${Date.now()}`,
      decision_hash: plan.decision_hash,
      quote,
    });
    trace.steps.push({ propose: proposeResult });
    if (!proposeResult?.ok) {
      trace.ok = false;
      trace.error = proposeResult?.reason || "propose_failed";
      return trace;
    }
  } else {
    trace.steps.push({
      propose: {
        ok: true,
        simulated: true,
        amount_raw: plan.amount_raw,
        note: "no propose adapter — path dry",
      },
    });
  }

  // MPC request_signature
  let signResult = null;
  if (adapters?.requestSignature) {
    signResult = await adapters.requestSignature({
      operation_id: proposeResult.operation_id || plan.fitter_operation_id,
      attached_deposit_yocto: "1",
    });
    trace.steps.push({ request_signature: signResult });
    if (!signResult?.ok) {
      trace.ok = false;
      trace.error = signResult?.reason || "sign_failed";
      // Ambiguous → UNKNOWN
      if (signResult?.ambiguous) {
        trace.unknown = true;
        trace.may_resign = false;
      }
      return trace;
    }
  } else {
    trace.steps.push({
      request_signature: {
        ok: true,
        simulated: true,
        note: "MPC signed event alone is NOT settlement",
      },
    });
  }

  const signedRaw = signResult?.signed_raw || "SIMULATED_SIGNED_RAW";
  const nonce = signResult?.nonce ?? "0";
  const operationId =
    proposeResult?.operation_id || plan.fitter_operation_id || `op-${Date.now()}`;

  if (journalPath) {
    try {
      const persisted = await persistPreBroadcast({
        journalPath,
        operationId,
        signedRaw,
        nonce,
        decisionHash: plan.decision_hash,
        network: mode === EXEC_MODE.TESTNET ? "testnet" : "shadow",
        mode,
      });
      trace.steps.push({ persist: persisted });
    } catch (e) {
      trace.ok = false;
      trace.error = String(e.message || e);
      trace.steps.push({ persist: { ok: false, error: trace.error } });
      return trace;
    }
  } else if (mode !== EXEC_MODE.SHADOW) {
    trace.ok = false;
    trace.error = "journal_path_required_for_non_shadow";
    return trace;
  }

  // Broadcast exactly once
  let broadcastResult = null;
  if (adapters?.broadcast && !simulateBroadcast) {
    try {
      broadcastResult = await adapters.broadcast({
        signed_raw: signedRaw,
        operation_id: operationId,
      });
    } catch (e) {
      const evalr = evaluateBroadcastAttempt({
        priorState: TX_STATE.BROADCAST_PENDING,
        transportError: String(e.message || e),
      });
      trace.steps.push({ broadcast_eval: evalr, error: String(e.message || e) });
      trace.ok = false;
      trace.unknown = evalr.action === "UNKNOWN_QUARANTINE";
      trace.may_resign = false;
      return trace;
    }
    const evalr = evaluateBroadcastAttempt({
      priorState: TX_STATE.SIGNED,
      rpcResult: broadcastResult,
    });
    trace.steps.push({ broadcast: broadcastResult, broadcast_eval: evalr });
    if (!evalr.ok) {
      trace.ok = false;
      trace.unknown = evalr.action === "UNKNOWN_QUARANTINE";
      return trace;
    }
  } else {
    trace.steps.push({
      broadcast: {
        ok: true,
        simulated: true,
        note: "single-broadcast policy armed; not sent in this run",
      },
    });
  }

  // Settlement verify — independent
  if (adapters?.settle) {
    const settle = await adapters.settle({
      operation_id: operationId,
      tx_hash: broadcastResult?.tx_hash,
    });
    trace.steps.push({ settle });
    if (settle?.status === "UNKNOWN" || settle?.unknown) {
      trace.ok = false;
      trace.unknown = true;
      trace.error = "settlement_unknown";
      return trace;
    }
    if (!settle?.ok) {
      trace.ok = false;
      trace.error = settle?.reason || "settle_failed";
      return trace;
    }
  } else {
    trace.steps.push({
      settle: {
        ok: false,
        skipped: true,
        note: "MPC signed ≠ settled; settle adapter required for E2E PASS",
      },
    });
  }

  // Reconcile — restricted; never invent success
  if (adapters?.reconcile) {
    const rec = await adapters.reconcile({
      operation_id: operationId,
      independent_evidence: true,
    });
    trace.steps.push({ reconcile: rec });
    if (!rec?.ok) {
      trace.ok = false;
      trace.error = rec?.reason || "reconcile_failed";
      return trace;
    }
  } else {
    trace.steps.push({
      reconcile: {
        ok: false,
        skipped: true,
        note: "reconciler required; cannot invent Success",
      },
    });
  }

  // Honest E2E: require settle+reconcile adapters for full PASS
  const hasSettle = trace.steps.some((s) => s.settle && s.settle.ok && !s.settle.skipped);
  const hasRec = trace.steps.some((s) => s.reconcile && s.reconcile.ok && !s.reconcile.skipped);
  trace.ok = Boolean(plan.execute && hasSettle && hasRec);
  if (!trace.ok && plan.execute) {
    trace.partial = true;
    trace.note =
      "Execution plan + fitter binding exercised; full settlement E2E requires settle+reconcile adapters";
  }
  trace.finished_at = new Date().toISOString();
  return trace;
}
