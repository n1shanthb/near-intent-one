/**
 * Hosted settlement worker — advances MPC_SIGNED → … → RECONCILED.
 * Default OFF (GATE_K_SETTLEMENT_WORKER=0). Never re-signs.
 * AI LLM work must not share this timer's critical path (separate interval, Nice).
 */
import {
  LIFECYCLE,
  BROADCASTABLE,
  RECEIPT_WAIT,
  SETTLE_WAIT,
  alreadySigned,
  isTerminalSuccess,
  normalizeLifecycleStatus,
} from "../gate-k/lifecycle.mjs";
import { advanceBroadcast, advanceConfirm } from "../gate-k/settle.mjs";
import { TIDEPOOL, USDC_SEPOLIA } from "../../scripts/lib/near-live.mjs";
import { verifyBeforeReconcile } from "../reconcile/verify-settlement.mjs";

export function createSettlementWorker(deps) {
  const {
    store,
    eth,
    nearRpc,
    rpcUrl,
    viewFunction,
    reconciler,
    logger = console,
    enabled = false,
    dryRun = true,
    intervalMs = 30_000,
    maxPerTick = 2,
  } = deps;

  let timer = null;
  let ticking = false;

  function listPending() {
    const execs = store.read().executions || {};
    return Object.entries(execs)
      .filter(([, e]) => e?.kind === "gate_k_ai_trade" || e?.kind === "personal_trade")
      .map(([key, e]) => ({ key, ...e }))
      .filter((e) => {
        if (isTerminalSuccess(e.status)) return false;
        if (e.status === LIFECYCLE.FAILED || e.status === LIFECYCLE.BLOCKED) return false;
        const st = normalizeLifecycleStatus(e.status);
        return (
          BROADCASTABLE.has(e.status) ||
          BROADCASTABLE.has(st) ||
          RECEIPT_WAIT.has(e.status) ||
          SETTLE_WAIT.has(e.status)
        );
      });
  }

  async function processOne(entry) {
    const portfolio = store.getPortfolio(entry.portfolio_id);
    if (!portfolio) {
      store.finishExecution(entry.key, {
        status: LIFECYCLE.FAILED,
        reason: "portfolio_missing",
      });
      return { key: entry.key, ok: false, reason: "portfolio_missing" };
    }

    if (!alreadySigned(entry.status) && !BROADCASTABLE.has(entry.status)) {
      return { key: entry.key, ok: false, reason: "not_signed_skip" };
    }
    if (!entry.sign_tx && !entry.sepolia_tx) {
      return { key: entry.key, ok: false, reason: "missing_sign_tx" };
    }

    let status = normalizeLifecycleStatus(entry.status);

    if (BROADCASTABLE.has(entry.status) || status === LIFECYCLE.MPC_SIGNED) {
      const br = await advanceBroadcast(
        { eth, nearRpc, rpcUrl, agentAccount: portfolio.agent_account },
        { exec: entry, portfolio },
        { dryRun }
      );
      if (!br.ok) {
        store.finishExecution(entry.key, {
          status: br.status || LIFECYCLE.MPC_SIGNED,
          last_error: br.reason,
          retryable: br.retryable !== false,
        });
        return { key: entry.key, ...br };
      }
      if (br.dry_run) {
        return { key: entry.key, ...br };
      }
      store.finishExecution(entry.key, {
        status: LIFECYCLE.BROADCAST,
        sepolia_tx: br.sepolia_tx,
        explorer: br.explorer,
        lifecycle_note: "broadcasted_no_resign",
      });
      entry = { ...entry, sepolia_tx: br.sepolia_tx, status: LIFECYCLE.BROADCAST };
      status = LIFECYCLE.BROADCAST;
    }

    if (RECEIPT_WAIT.has(entry.status) || status === LIFECYCLE.BROADCAST) {
      const conf = await advanceConfirm({ eth }, { exec: entry });
      if (!conf.ok) {
        store.finishExecution(entry.key, {
          status: conf.status,
          last_error: conf.reason,
          receipt_status: conf.receipt_status,
          retryable: conf.retryable === true,
        });
        return { key: entry.key, ...conf };
      }
      store.finishExecution(entry.key, {
        status: LIFECYCLE.SETTLEMENT_PENDING,
        receipt_status: "0x1",
        sepolia_tx: conf.sepolia_tx,
      });
      entry = {
        ...entry,
        status: LIFECYCLE.SETTLEMENT_PENDING,
        sepolia_tx: conf.sepolia_tx,
        receipt_status: "0x1",
      };
    }

    if (SETTLE_WAIT.has(entry.status) || entry.status === LIFECYCLE.SETTLEMENT_PENDING) {
      if (dryRun) {
        return {
          key: entry.key,
          ok: true,
          dry_run: true,
          status: LIFECYCLE.SETTLEMENT_PENDING,
          note: "settle_suppressed_dry_run",
        };
      }
      try {
        await fetch(`${TIDEPOOL}/v0/deposit/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            txHash: entry.sepolia_tx,
            depositAddress: entry.to,
          }),
        });
      } catch (e) {
        logger.warn?.(`[settle] tidepool submit ${e.message || e}`);
      }

      let terminal = null;
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const st = await fetch(
            `${TIDEPOOL}/v0/status?depositAddress=${encodeURIComponent(entry.to)}`
          ).then((r) => r.json());
          if (["SUCCESS", "REFUNDED", "FAILED", "EXPIRED"].includes(st.status)) {
            terminal = st;
            break;
          }
        } catch {
          /* */
        }
      }

      if (!terminal || terminal.status !== "SUCCESS") {
        store.finishExecution(entry.key, {
          status: LIFECYCLE.SETTLEMENT_PENDING,
          tidepool_status: terminal?.status || "PENDING",
          retryable: true,
        });
        return {
          key: entry.key,
          ok: false,
          retryable: true,
          reason: "SETTLEMENT_PENDING",
          tidepool: terminal?.status,
        };
      }

      store.finishExecution(entry.key, {
        status: LIFECYCLE.SETTLED,
        tidepool_status: "SUCCESS",
      });

      if (reconciler?.reconcile && viewFunction) {
        try {
          const pending = await viewFunction(portfolio.policy_contract, "get_pending", {
            operation_id: entry.operation_id,
          });
          const verified = await verifyBeforeReconcile({
            pendingOp: pending,
            originTxHash: entry.sepolia_tx,
            expectedSender: portfolio.intents_signer_id,
            expectedToken: USDC_SEPOLIA,
            expectedRecipient: entry.to,
            expectedAmount: entry.amount,
            depositAddress: entry.to,
          });
          if (verified.may_reconcile) {
            const rec = await reconciler.reconcile({
              policyContract: portfolio.policy_contract,
              operationId: entry.operation_id,
              pendingOp: pending,
              originTxHash: entry.sepolia_tx,
              expectedSender: portfolio.intents_signer_id,
              expectedToken: USDC_SEPOLIA,
              expectedRecipient: entry.to,
              expectedAmount: entry.amount,
              depositAddress: entry.to,
            });
            if (rec.ok) {
              store.finishExecution(entry.key, {
                status: LIFECYCLE.RECONCILED,
                reconcile_tx: rec.tx,
              });
              return {
                key: entry.key,
                ok: true,
                status: LIFECYCLE.RECONCILED,
              };
            }
          }
          store.finishExecution(entry.key, {
            status: LIFECYCLE.SETTLED,
            last_error: "reconcile_deferred",
            retryable: true,
          });
        } catch (e) {
          store.finishExecution(entry.key, {
            status: LIFECYCLE.SETTLED,
            last_error: String(e.message || e).slice(0, 200),
            retryable: true,
          });
        }
      }
      return { key: entry.key, ok: true, status: LIFECYCLE.SETTLED };
    }

    return { key: entry.key, ok: true, status: entry.status };
  }

  async function tick() {
    if (!enabled) return { ok: true, enabled: false, processed: [] };
    if (ticking) return { ok: true, busy: true, processed: [] };
    ticking = true;
    const processed = [];
    try {
      const pending = listPending().slice(0, maxPerTick);
      for (const entry of pending) {
        try {
          processed.push(await processOne(entry));
        } catch (e) {
          logger.error?.(`[settle-worker] ${entry.key} ${e.message || e}`);
          processed.push({
            key: entry.key,
            ok: false,
            reason: String(e.message || e).slice(0, 200),
          });
        }
      }
    } finally {
      ticking = false;
    }
    return { ok: true, enabled: true, dry_run: dryRun, processed };
  }

  return {
    health() {
      return {
        ok: true,
        role: "settlement_worker",
        enabled,
        dry_run: dryRun,
        pending: listPending().length,
        ticking,
      };
    },
    listPending,
    tick,
    start() {
      if (!enabled || timer) return { ok: false, reason: enabled ? "already" : "disabled" };
      timer = setInterval(() => {
        tick().catch((e) => logger.error?.(`[settle-worker] ${e.message || e}`));
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
      return { ok: true, interval_ms: intervalMs };
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      return { ok: true };
    },
  };
}
