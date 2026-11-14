/**
 * Autonomous execution service — non-interactive M1/M2-shaped pipeline.
 * TESTNET / LOCAL_FORK require real adapters and genuine signed bytes.
 * SHADOW/FIXTURE may simulate only when explicitly labeled.
 * Never treats LLM as authority. MAINNET hard-stopped in J15.
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
import {
  assembleSignedEvmFromMpc,
  validateSignedRawAgainstPolicy,
  broadcastSignedRawOnce,
  verifySettlementFromReceipt,
} from "./signedTxPipeline.mjs";

export const EXEC_LABEL = Object.freeze({
  SHADOW: "SHADOW",
  FIXTURE: "FIXTURE",
  LOCAL_FORK: "LOCAL_FORK",
  TESTNET: "TESTNET",
  MAINNET: "MAINNET",
});

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

function isFinancialMode(mode) {
  return (
    mode === EXEC_MODE.TESTNET ||
    mode === EXEC_MODE.MAINNET ||
    mode === EXEC_MODE.LOCAL_FORK ||
    mode === "LOCAL_FORK"
  );
}

function isPlaceholderSignedRaw(raw) {
  if (!raw) return true;
  const s = String(raw);
  if (s === "SIMULATED_SIGNED_RAW") return true;
  if (/TESTNET_MPC_PENDING/i.test(s)) return true;
  // UTF-8 hex of TESTNET_MPC_PENDING prefix
  if (/^544553544e45545f4d50435f50454e44494e47/i.test(s.replace(/^0x/, ""))) {
    return true;
  }
  if (!s.startsWith("0x") && !/^[0-9a-fA-F]+$/.test(s)) return true;
  const hex = s.replace(/^0x/, "");
  // Real EIP-155 legacy txs are long RLP; reject trivially short blobs
  if (hex.length < 100) return true;
  return false;
}

/**
 * Run one autonomous execution attempt.
 *
 * @param {object} opts
 * @param {object} opts.decision
 * @param {object} opts.mandate
 * @param {object} opts.onChain
 * @param {object} [opts.quote]
 * @param {string} [opts.mode]
 * @param {object} [opts.adapters]
 * @param {string} [opts.journalPath]
 * @param {boolean} [opts.simulateBroadcast] — SHADOW/FIXTURE only; ignored/refused in financial modes
 * @param {object} [opts.lockedTx] — nonce/gas/token/deposit/amount/chainId/expectedMpc/digest
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
    simulateBroadcast = mode === EXEC_MODE.SHADOW,
    lockedTx = null,
  } = opts;

  assert(decision, "decision_required");
  assert(mandate, "mandate_required");
  assert(onChain, "on_chain_required");

  const financial = isFinancialMode(mode);
  const allowSimulate = !financial && simulateBroadcast === true;

  const trace = {
    started_at: new Date().toISOString(),
    mode,
    financial,
    steps: [],
    ok: false,
  };

  const planMode =
    mode === EXEC_MODE.LOCAL_FORK || mode === "LOCAL_FORK"
      ? EXEC_MODE.LOCAL_FORK
      : mode;
  const plan = planAutonomousExecution({
    decision,
    mandate,
    onChain,
    quote,
    mode: planMode === EXEC_MODE.LOCAL_FORK ? EXEC_MODE.TESTNET : planMode,
  });
  if (plan.execute) plan.mode = planMode;

  trace.plan = plan;
  trace.steps.push({
    plan: plan.execute ? "EXECUTE" : "SKIP",
    blockers: plan.blockers,
  });

  if (!plan.execute) {
    trace.ok = plan.ok !== false;
    trace.finished_at = new Date().toISOString();
    return trace;
  }

  if (mode === EXEC_MODE.MAINNET && process.env.NIO_MAINNET_AUTONOMOUS_EXEC !== "1") {
    trace.ok = false;
    trace.error = "mainnet_hard_stopped";
    return trace;
  }

  // Fail-closed: financial modes require quote + adapters
  if (financial) {
    if (!quote || quote.stale || quote.expired) {
      trace.ok = false;
      trace.error = "quote_required_fresh";
      return trace;
    }
    if (!adapters?.propose) {
      trace.ok = false;
      trace.error = "propose_adapter_required";
      return trace;
    }
    if (!adapters?.requestSignature && !adapters?.assembleSignedRaw) {
      trace.ok = false;
      trace.error = "mpc_or_assemble_adapter_required";
      return trace;
    }
    if (!adapters?.broadcast) {
      trace.ok = false;
      trace.error = "broadcast_adapter_required";
      return trace;
    }
    if (!adapters?.settle) {
      trace.ok = false;
      trace.error = "settle_adapter_required";
      return trace;
    }
    if (!adapters?.reconcile) {
      trace.ok = false;
      trace.error = "reconcile_adapter_required";
      return trace;
    }
    if (!journalPath) {
      trace.ok = false;
      trace.error = "journal_path_required_for_financial";
      return trace;
    }
    if (simulateBroadcast) {
      trace.ok = false;
      trace.error = "simulate_broadcast_forbidden_in_financial_mode";
      return trace;
    }
  }

  // Propose
  let proposeResult = null;
  if (adapters?.propose) {
    proposeResult = await adapters.propose({
      amount_raw: plan.amount_raw,
      operation_id: plan.fitter_operation_id || `auto-${Date.now()}`,
      decision_hash: plan.decision_hash,
      quote,
      lockedTx,
    });
    trace.steps.push({ propose: proposeResult });
    if (!proposeResult?.ok) {
      trace.ok = false;
      trace.error = proposeResult?.reason || "propose_failed";
      return trace;
    }
    if (
      proposeResult.amount_raw &&
      String(proposeResult.amount_raw) !== String(plan.amount_raw)
    ) {
      trace.ok = false;
      trace.error = "propose_amount_diverges_from_fitter";
      return trace;
    }
  } else if (allowSimulate) {
    trace.steps.push({
      propose: {
        ok: true,
        simulated: true,
        amount_raw: plan.amount_raw,
        label: "SHADOW_OR_FIXTURE",
      },
    });
  } else {
    trace.ok = false;
    trace.error = "propose_adapter_required";
    return trace;
  }

  const operationId =
    proposeResult?.operation_id || plan.fitter_operation_id || `op-${Date.now()}`;

  // MPC / assemble signed raw
  let signResult = null;
  let signedRaw = null;
  let nonce = null;

  if (adapters?.assembleSignedRaw) {
    signResult = await adapters.assembleSignedRaw({
      operation_id: operationId,
      amount_raw: plan.amount_raw,
      quote,
      lockedTx,
      propose: proposeResult,
    });
    trace.steps.push({ assemble_signed_raw: signResult });
    if (!signResult?.ok) {
      trace.ok = false;
      trace.error = signResult?.reason || "assemble_failed";
      return trace;
    }
    signedRaw = signResult.signed_raw || signResult.rawHex;
    nonce = signResult.nonce;
  } else if (adapters?.requestSignature) {
    signResult = await adapters.requestSignature({
      operation_id: operationId,
      attached_deposit_yocto: "1",
      lockedTx,
      quote,
    });
    trace.steps.push({ request_signature: signResult });
    if (!signResult?.ok) {
      trace.ok = false;
      trace.error = signResult?.reason || "sign_failed";
      if (signResult?.ambiguous) {
        trace.unknown = true;
        trace.may_resign = false;
      }
      return trace;
    }

    // If adapter only returned NEAR MPC outcome, assemble EVM raw here
    if (signResult.near_tx_full && lockedTx) {
      const assembled = assembleSignedEvmFromMpc({
        nearTxFull: signResult.near_tx_full,
        ...lockedTx,
        amount: lockedTx.amount ?? plan.amount_raw,
      });
      trace.steps.push({ assemble_from_mpc: assembled });
      if (!assembled.ok) {
        trace.ok = false;
        trace.error = assembled.reason || "mpc_assemble_failed";
        return trace;
      }
      signedRaw = assembled.rawHex;
      nonce = assembled.nonce;
      signResult = { ...signResult, ...assembled, signed_raw: assembled.rawHex };
    } else {
      signedRaw = signResult.signed_raw || signResult.rawHex;
      nonce = signResult.nonce;
    }
  } else if (allowSimulate) {
    trace.steps.push({
      request_signature: {
        ok: true,
        simulated: true,
        label: "SHADOW_OR_FIXTURE",
        note: "MPC signed event alone is NOT settlement",
      },
    });
    signedRaw = "SIMULATED_SIGNED_RAW";
    nonce = "0";
  } else {
    trace.ok = false;
    trace.error = "signature_adapter_required";
    return trace;
  }

  if (financial) {
    if (isPlaceholderSignedRaw(signedRaw)) {
      trace.ok = false;
      trace.error = "placeholder_signed_raw_forbidden";
      return trace;
    }
    // TESTNET financial path must carry authentic MPC provenance when claiming NEAR-MPC
    if (
      mode === EXEC_MODE.TESTNET &&
      adapters?.requestSignature &&
      !signResult?.near_tx_full &&
      !signResult?.mpc_signature &&
      signResult?.label === "LOCAL_KEY_NOT_NEAR_MPC"
    ) {
      trace.ok = false;
      trace.error = "local_key_forbidden_as_near_mpc_substitute";
      return trace;
    }
    if (nonce === undefined || nonce === null) {
      trace.ok = false;
      trace.error = "nonce_required";
      return trace;
    }
    if (lockedTx) {
      const v = validateSignedRawAgainstPolicy({
        signedRawHex: signedRaw.startsWith("0x") ? signedRaw : `0x${signedRaw}`,
        expected: {
          chainId: lockedTx.chainId,
          nonce: lockedTx.nonce,
          token: lockedTx.token,
          mpc: lockedTx.expectedMpc,
          depositAddress: lockedTx.depositAddress,
          amount: lockedTx.amount ?? plan.amount_raw,
          maxGasPrice: lockedTx.maxGasPrice,
          digestHex: lockedTx.expectedDigestHex,
        },
      });
      trace.steps.push({ validate_signed_raw: v });
      if (!v.ok) {
        trace.ok = false;
        trace.error = "signed_raw_policy_mismatch";
        trace.blockers = v.blockers;
        return trace;
      }
    }
  }

  const rawForJournal = String(signedRaw).startsWith("0x")
    ? String(signedRaw)
    : financial
      ? `0x${signedRaw}`
      : String(signedRaw);

  if (journalPath) {
    try {
      const persisted = await persistPreBroadcast({
        journalPath,
        operationId,
        signedRaw: rawForJournal,
        nonce: String(nonce),
        decisionHash: plan.decision_hash,
        network:
          mode === EXEC_MODE.TESTNET
            ? "testnet"
            : mode === EXEC_MODE.LOCAL_FORK || mode === "LOCAL_FORK"
              ? "local_fork"
              : "shadow",
        mode: financial ? EXEC_MODE.TESTNET : EXEC_MODE.SHADOW,
      });
      trace.steps.push({ persist: persisted });
      if (!persisted?.ok) {
        trace.ok = false;
        trace.error = "persist_failed";
        return trace;
      }
    } catch (e) {
      trace.ok = false;
      trace.error = String(e.message || e);
      trace.steps.push({ persist: { ok: false, error: trace.error } });
      return trace;
    }
  } else if (financial) {
    trace.ok = false;
    trace.error = "journal_path_required_for_financial";
    return trace;
  }

  // Broadcast
  let broadcastResult = null;
  if (financial || (adapters?.broadcast && !allowSimulate)) {
    try {
      broadcastResult = await adapters.broadcast({
        signed_raw: rawForJournal,
        operation_id: operationId,
        lockedTx,
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
      trace.may_resign = false;
      return trace;
    }
    if (!broadcastResult?.tx_hash) {
      trace.ok = false;
      trace.error = "broadcast_missing_tx_hash";
      return trace;
    }
  } else if (allowSimulate) {
    trace.steps.push({
      broadcast: {
        ok: true,
        simulated: true,
        label: "SHADOW_OR_FIXTURE",
      },
    });
  } else {
    trace.ok = false;
    trace.error = "broadcast_required";
    return trace;
  }

  // Settlement
  if (adapters?.settle) {
    const settle = await adapters.settle({
      operation_id: operationId,
      tx_hash: broadcastResult?.tx_hash,
      lockedTx,
      signed_raw: rawForJournal,
    });
    trace.steps.push({ settle });
    if (settle?.status === "UNKNOWN" || settle?.unknown) {
      trace.ok = false;
      trace.unknown = true;
      trace.error = "settlement_unknown";
      trace.may_resign = false;
      return trace;
    }
    if (!settle?.ok) {
      trace.ok = false;
      trace.error = settle?.reason || "settle_failed";
      return trace;
    }
  } else if (allowSimulate) {
    trace.steps.push({
      settle: {
        ok: false,
        skipped: true,
        label: "SHADOW_OR_FIXTURE",
        note: "settle not claimed in shadow",
      },
    });
  } else {
    trace.ok = false;
    trace.error = "settle_required";
    return trace;
  }

  // Reconcile
  if (adapters?.reconcile) {
    const settleObj = trace.steps.find((s) => s.settle)?.settle;
    const settleOk = Boolean(settleObj?.ok && !settleObj?.skipped);
    // Financial modes: only independently_verified settles count as independent evidence.
    // Simulator / synthetic settles may be ok for LOCAL_FORK labels but are not independent.
    const independentEvidence = financial
      ? settleOk &&
        (settleObj?.independently_verified === true ||
          settleObj?.financial_readiness === true)
      : settleOk;
    const rec = await adapters.reconcile({
      operation_id: operationId,
      independent_evidence: independentEvidence === true,
      settle: settleObj,
    });
    trace.steps.push({ reconcile: rec });
    if (!rec?.ok) {
      trace.ok = false;
      trace.error = rec?.reason || "reconcile_failed";
      return trace;
    }
  } else if (allowSimulate) {
    trace.steps.push({
      reconcile: {
        ok: false,
        skipped: true,
        label: "SHADOW_OR_FIXTURE",
      },
    });
  } else {
    trace.ok = false;
    trace.error = "reconcile_required";
    return trace;
  }

  const hasSettle = trace.steps.some(
    (s) => s.settle && s.settle.ok && !s.settle.skipped
  );
  const hasRec = trace.steps.some(
    (s) => s.reconcile && s.reconcile.ok && !s.reconcile.skipped
  );
  const hasRealBroadcast = trace.steps.some(
    (s) => s.broadcast?.tx_hash && !s.broadcast?.simulated
  );
  trace.ok = Boolean(
    plan.execute && hasSettle && hasRec && (financial ? hasRealBroadcast : true)
  );
  if (!trace.ok && plan.execute) {
    trace.partial = true;
    trace.note =
      "Incomplete settlement path; refuse to claim PASS without settle+reconcile+broadcast evidence";
  }
  if ((mode === EXEC_MODE.LOCAL_FORK || mode === "LOCAL_FORK") && trace.ok) {
    trace.label = "LOCAL_FORK";
    trace.note =
      "LOCAL_FORK settlement proof — not a mainnet autonomous settlement";
  }
  trace.finished_at = new Date().toISOString();
  return trace;
}

export {
  assembleSignedEvmFromMpc,
  validateSignedRawAgainstPolicy,
  broadcastSignedRawOnce,
  verifySettlementFromReceipt,
};

export { EXEC_MODE };
