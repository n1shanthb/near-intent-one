/**
 * Simulate Autonomous Cycle
 * mandate create → research → BUY_DATA mock → reevaluate → trade (shadow) → journal replay
 * 
 * NO mainnet mutations.
 */

import { strict as assert } from "node:assert";
import { buildMandateV1Draft, validateMandateV1 } from "../mandate/v1/schema.mjs";
import { hashMandateV1 } from "../mandate/v1/compiler.mjs";
import { createShadowAgent, runShadowTick, ACTION } from "./shadowAgent.mjs";
import { discoverProviders, quoteService, createPurchaseOp, confirmPayment, retrieveDelivery, verifyDelivery, storeReceipts, releaseOrReconcile, reserveBudget, checkCommerceBalance } from "./agentMarket.mjs";
import { createShadowWorker, appendJournalEntry, acquireLock, releaseLock, transitionState, replayJournal, WORKER_STATE } from "./worker.mjs";

/**
 * Simulate full cycle: mandate → research → trade decision.
 * 
 * @param {object} params
 * @param {object} params.mandate_input - raw mandate input
 * @param {object} params.market - market snapshot
 * @param {string} params.portfolio_id
 * @returns {Promise<object>} simulation result
 */
export async function simulateCycle({ mandate_input, market, portfolio_id }) {
  assert(mandate_input, "mandate_input_required");
  assert(market, "market_required");
  assert(portfolio_id, "portfolio_id_required");

  const result = {
    ok: false,
    mandate: null,
    mandate_hash: null,
    worker: null,
    decisions: [],
    trades: [],
    purchases: [],
    errors: [],
  };

  try {
    // 1. Create mandate
    const mandate = buildMandateV1Draft(mandate_input);
    const validation = validateMandateV1(mandate);
    if (!validation.ok) {
      result.errors.push({ stage: "mandate_validation", reasons: validation.reasons });
      return result;
    }

    result.mandate = mandate;
    result.mandate_hash = hashMandateV1(mandate);

    // 2. Create worker
    const worker = await createShadowWorker({ portfolio_id });
    result.worker = worker;

    // 3. Acquire lock
    const locked = await acquireLock(worker);
    if (!locked) {
      result.errors.push({ stage: "lock", reason: "lock_failed" });
      return result;
    }

    // 4. Transition to RESEARCHING
    await transitionState(worker, WORKER_STATE.RESEARCHING);

    // 5. Create shadow agent
    const journal = {
      append: async (entry) => {
        await appendJournalEntry(worker, entry);
      },
    };

    const agent = createShadowAgent({
      mandate,
      journal,
    });

    // Add commerce budget to state
    agent.state.commerce_budget_raw = mandate.commerce_budget_raw;

    // 6. Run first tick (research + decide)
    await transitionState(worker, WORKER_STATE.DECIDING);
    const decision1 = await runShadowTick(agent, market);
    result.decisions.push(decision1);

    // 7. If BUY_DATA, simulate purchase
    if (decision1.action === ACTION.BUY_DATA && mandate.data_purchase_enabled) {
      await transitionState(worker, WORKER_STATE.EXECUTING);

      // Discover providers
      const providers = await discoverProviders(mandate);
      if (providers.length > 0) {
        const provider = providers[0];
        const service = provider.services[0];

        // Quote
        const quote = await quoteService(provider.provider_id, service.service_id);

        // Reserve budget
        const reservation = reserveBudget(agent.state, quote.price_usd_micros);
        if (!reservation.ok) {
          result.errors.push({ stage: "purchase", reason: reservation.reason });
        } else {
          // Create purchase op
          const op = createPurchaseOp(quote, reservation);

          // Confirm payment (mock)
          const confirmation = await confirmPayment(op);

          // Retrieve delivery
          const delivery = await retrieveDelivery(op);

          // Verify delivery
          const valid = verifyDelivery(delivery);
          if (!valid) {
            result.errors.push({ stage: "purchase", reason: "delivery_verification_failed" });
          } else {
            // Store receipts
            storeReceipts(journal, op, delivery);

            // Commit spend
            releaseOrReconcile(agent.state, reservation, true);

            result.purchases.push({ op, delivery });

            // Update market with purchased data
            market.purchased_data = delivery.data;
          }
        }
      }

      // 8. Re-evaluate with new data
      await transitionState(worker, WORKER_STATE.DECIDING);
      const decision2 = await runShadowTick(agent, market);
      result.decisions.push(decision2);

      // 9. If TRADE, record shadow trade
      if (decision2.action === ACTION.TRADE) {
        await transitionState(worker, WORKER_STATE.EXECUTING);
        const trade = {
          kind: "trade",
          action: "SHADOW_BUY",
          asset_in: "native:near",
          asset_out: "nep141:usdc.near",
          amount_raw: decision2.strategy.proposed_size_usdc_raw,
          timestamp_ms: Date.now(),
          shadow: true,
        };
        await appendJournalEntry(worker, trade);
        result.trades.push(trade);
      }
    } else if (decision1.action === ACTION.TRADE) {
      // Direct trade (no data purchase)
      await transitionState(worker, WORKER_STATE.EXECUTING);
      const trade = {
        kind: "trade",
        action: "SHADOW_BUY",
        asset_in: "native:near",
        asset_out: "nep141:usdc.near",
        amount_raw: decision1.strategy.proposed_size_usdc_raw,
        timestamp_ms: Date.now(),
        shadow: true,
      };
      await appendJournalEntry(worker, trade);
      result.trades.push(trade);
    }

    // 10. Reconcile
    await transitionState(worker, WORKER_STATE.RECONCILING);

    // 11. Replay journal
    const replayed_state = replayJournal(worker);

    // 12. Return to IDLE
    await transitionState(worker, WORKER_STATE.IDLE);

    // 13. Release lock
    await releaseLock(worker);

    result.ok = true;
    result.replayed_state = replayed_state;
  } catch (err) {
    result.errors.push({ stage: "simulation", error: err.message, stack: err.stack });
    if (result.worker) {
      await transitionState(result.worker, WORKER_STATE.ERROR).catch(() => {});
      await releaseLock(result.worker).catch(() => {});
    }
  }

  return result;
}

/**
 * Simulate crash and restart.
 * 
 * @param {object} worker
 * @returns {Promise<object>} recovery result
 */
export async function simulateCrashRestart(worker) {
  // Simulate crash (lock not released, state unknown)
  worker.state = WORKER_STATE.UNKNOWN;

  // Restart: replay journal
  const recovered_state = replayJournal(worker);

  // Reset to IDLE
  await transitionState(worker, WORKER_STATE.IDLE);

  return {
    ok: true,
    recovered_state,
  };
}
