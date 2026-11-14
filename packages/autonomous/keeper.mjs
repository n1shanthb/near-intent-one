/**
 * Unattended autonomous keeper (shadow-capable).
 * Cross-process lock, durable journal, real OpenRouter pipeline, restart recovery.
 * HARD STOP: never broadcasts, never MPC, never mainnet mutations.
 */

import { strict as assert } from "node:assert";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchMarketSnapshot } from "../gate-j/market.mjs";
import { loadServicesEnv, getLlmConfig, seedSpendState } from "../gate-j/llm.mjs";
import {
  createShadowWorker,
  appendJournalEntry,
  acquireLock,
  releaseLock,
  transitionState,
  replayJournal,
  verifyJournalIntegrity,
  persistBudget,
  markUnknownOutcome,
  WORKER_STATE,
} from "./worker.mjs";
import { createShadowAgent, runShadowTick, ACTION, LLM_MODE } from "./shadowAgent.mjs";
import {
  planAutonomousExecution,
  executeShadowPlan,
  EXEC_MODE,
} from "./executorAdapter.mjs";

/**
 * Run N keeper cycles.
 *
 * @param {object} opts
 * @param {object} opts.mandate
 * @param {string} opts.portfolio_id
 * @param {string} [opts.journal_dir]
 * @param {number} [opts.cycles=3]
 * @param {number} [opts.wake_ms=0] — delay between cycles
 * @param {"fixture"|"LIVE_LLM"} [opts.llmMode]
 * @param {boolean} [opts.liveMarket=true] — fetch live market when LIVE_LLM
 * @param {string} [opts.evidence_dir]
 */
export async function runKeeperCycles(opts) {
  const {
    mandate,
    portfolio_id,
    journal_dir,
    cycles = 3,
    wake_ms = 0,
    llmMode = LLM_MODE.LIVE_LLM,
    liveMarket = llmMode === LLM_MODE.LIVE_LLM,
    evidence_dir = null,
  } = opts;

  assert(mandate, "mandate_required");
  assert(portfolio_id, "portfolio_id_required");

  loadServicesEnv();
  const llmCfg = getLlmConfig();

  const worker = await createShadowWorker({ portfolio_id, journal_dir });
  const integrity = verifyJournalIntegrity(worker);
  if (!integrity.ok) {
    return {
      ok: false,
      verdict: "FAIL",
      reason: "journal_integrity_failed",
      integrity,
      cycles: [],
    };
  }

  const locked = await acquireLock(worker);
  if (!locked) {
    return {
      ok: false,
      verdict: "FAIL",
      reason: "lock_not_acquired",
      cycles: [],
    };
  }

  const results = {
    ok: true,
    verdict: "PASS",
    llm_mode: llmMode,
    llm_configured: llmCfg.configured,
    models: llmCfg.models,
    portfolio_id,
    journal_path: worker.journal_path,
    started_at: new Date().toISOString(),
    cycles: [],
    integrity_before: integrity,
    integrity_after: null,
    errors: [],
  };

  try {
    // Recover budget into spend seed
    const recovered = replayJournal(worker);
    seedSpendState({
      usd: recovered.openrouter_spent_usd || 0,
      calls: recovered.openrouter_requests_today || 0,
    });

    if (recovered.unknown_outcome || worker.unknown_blocks_spend) {
      results.ok = false;
      results.verdict = "HOLD_UNKNOWN";
      results.errors.push({
        reason: "unknown_outcome_blocks_spend",
        note: "Independent reconcile required before further spending",
      });
      await appendJournalEntry(worker, {
        kind: "keeper_blocked",
        reason: "unknown_outcome",
      });
      return results;
    }

    for (let i = 0; i < cycles; i++) {
      const cycle = {
        index: i + 1,
        started_at: new Date().toISOString(),
        decision: null,
        shadow_execution: null,
        error: null,
      };

      try {
        await transitionState(worker, WORKER_STATE.RESEARCHING);

        let market;
        if (liveMarket) {
          market = await fetchMarketSnapshot({});
        } else {
          market = await fetchMarketSnapshot({
            fixture: {
              as_of: new Date().toISOString(),
              near_usd: 5.0,
              usdc_usd: 1.0,
              pair: { origin: "USDC", destination: "wNEAR" },
              volatility_bps_1h: 40,
              liquidity_score: 0.7,
              sources: [{ name: "keeper_fixture", as_of: new Date().toISOString() }],
            },
          });
        }

        await appendJournalEntry(worker, {
          kind: "market_observation",
          as_of: market.as_of,
          stale: market.stale,
          near_usd: market.near_usd ?? null,
          sources: (market.sources || []).map((s) => s.name),
        });

        if (market.stale) {
          await transitionState(worker, WORKER_STATE.IDLE);
          cycle.decision = {
            action: ACTION.HOLD,
            reason: "STALE_MARKET",
          };
          results.cycles.push(cycle);
          if (wake_ms > 0 && i < cycles - 1) await sleep(wake_ms);
          continue;
        }

        await transitionState(worker, WORKER_STATE.DECIDING);

        const journal = {
          append: async (entry) => appendJournalEntry(worker, entry),
        };

        const agent = createShadowAgent({
          mandate,
          journal,
          llmMode,
          unknownBlocksSpend: worker.unknown_blocks_spend,
        });
        // Hydrate authoritative budget
        agent.state.spent_today_raw = recovered.spent_today_raw;
        agent.state.pending_exposure_raw = recovered.pending_exposure_raw;
        agent.state.openrouter_spent_usd =
          worker.budget.openrouter_spent_usd || recovered.openrouter_spent_usd;
        agent.state.openrouter_requests_today =
          worker.budget.openrouter_requests_today ||
          recovered.openrouter_requests_today;
        agent.state.recent_operation_sizes = recovered.recent_operation_sizes || [];
        agent.state.balance_usdc_raw =
          recovered.balance_usdc_raw || mandate.total_trading_budget_raw;

        const decision = await runShadowTick(agent, market);
        cycle.decision = {
          action: decision.action,
          reason: decision.reason,
          decision_hash: decision.decision_hash,
          mandate_hash: decision.mandate_hash,
          fitter_outcome: decision.fitter?.outcome || null,
          models: decision.evidence?.models || null,
          spend: decision.evidence?.spend || null,
          enforcement: decision.evidence?.enforcement?.decision || null,
        };

        // Persist budget from agent
        worker.budget.openrouter_spent_usd = agent.state.openrouter_spent_usd;
        worker.budget.openrouter_requests_today = agent.state.openrouter_requests_today;
        await persistBudget(worker);

        // Execution adapter (SHADOW default; MAINNET hard-stopped in planner)
        const plan = planAutonomousExecution({
          decision,
          mandate,
          onChain: {
            paused: false,
            revoked: false,
            autonomous_trading: Boolean(mandate.trading_enabled),
            enforce_autonomous_on_agent: true,
          },
          mode: EXEC_MODE.SHADOW,
        });
        cycle.execution_plan = {
          execute: plan.execute,
          reason: plan.reason || null,
          blockers: plan.blockers || null,
          requires_owner_ledger_per_trade: plan.requires_owner_ledger_per_trade ?? null,
        };

        if (plan.execute) {
          await transitionState(worker, WORKER_STATE.EXECUTING);
          const exec = await executeShadowPlan(plan, {
            appendJournal: (e) => appendJournalEntry(worker, e),
          });
          cycle.shadow_execution = exec.record || exec;
          if (exec.record?.amount_raw) {
            const amt = BigInt(exec.record.amount_raw || "0");
            worker.budget.spent_today_raw = (
              BigInt(worker.budget.spent_today_raw || "0") + amt
            ).toString();
            worker.budget.recent_operation_sizes = [
              ...(worker.budget.recent_operation_sizes || []),
              exec.record.amount_raw,
            ].slice(-20);
            await persistBudget(worker);
          }
          await transitionState(worker, WORKER_STATE.RECONCILING);
        } else {
          await transitionState(worker, WORKER_STATE.IDLE);
        }

        if (worker.state === WORKER_STATE.RECONCILING) {
          await appendJournalEntry(worker, {
            kind: "reconcile",
            mode: "shadow",
            decision_hash: decision.decision_hash,
            status: "SHADOW_RECONCILED",
          });
          await transitionState(worker, WORKER_STATE.IDLE);
        } else {
          await appendJournalEntry(worker, {
            kind: "reconcile",
            mode: "shadow",
            decision_hash: decision.decision_hash,
            status: "SHADOW_NO_EXEC",
          });
        }
        worker.last_tick_ms = Date.now();
      } catch (err) {
        cycle.error = String(err.message || err).slice(0, 500);
        results.errors.push({ cycle: i + 1, error: cycle.error });
        try {
          await markUnknownOutcome(worker, { cycle: i + 1, error: cycle.error });
        } catch {
          await transitionState(worker, WORKER_STATE.ERROR).catch(() => {});
        }
        // Do not continue spending after UNKNOWN
        results.cycles.push(cycle);
        break;
      }

      results.cycles.push(cycle);
      if (wake_ms > 0 && i < cycles - 1) await sleep(wake_ms);
    }

    results.integrity_after = verifyJournalIntegrity(worker);
    if (!results.integrity_after.ok) {
      results.ok = false;
      results.verdict = "FAIL";
      results.errors.push({ reason: "journal_integrity_after_failed" });
    }

    results.finished_at = new Date().toISOString();
    results.replayed_state = replayJournal(worker);
    results.health = {
      state: worker.state,
      tip_hash: worker.tip_hash,
      entries: worker.entries.length,
      unknown_blocks_spend: worker.unknown_blocks_spend,
    };

    if (evidence_dir) {
      await mkdir(evidence_dir, { recursive: true });
      const path = join(evidence_dir, `J12_KEEPER_${portfolio_id}_${Date.now()}.json`);
      await writeFile(path, JSON.stringify(results, null, 2), "utf8");
      results.evidence_path = path;
    }
  } finally {
    await releaseLock(worker).catch(() => {});
  }

  return results;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
