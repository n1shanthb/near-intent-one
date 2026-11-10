/**
 * Gate K unattended testnet agent loop.
 * NEVER starts on deployment. Requires:
 * - on-chain autonomous_trading === true (owner-approved)
 * - GATE_K_AUTONOMOUS_LOOP=1 process env
 * - authenticated service context
 * - reconciler healthy
 *
 * Features: cooldown, single-flight, idempotency, circuit breaker, spend cap.
 */
import { runGateKPipeline } from "./pipeline.mjs";
import { MODE, REASON, FIRST_TEST } from "./constants.mjs";
import { getSpendState } from "../gate-j/llm.mjs";

const DEFAULT_COOLDOWN_MS = Number(process.env.GATE_K_COOLDOWN_MS || 5 * 60_000);
const DEFAULT_INTERVAL_MS = Number(process.env.GATE_K_LOOP_INTERVAL_MS || 60_000);
const DEFAULT_MAX_FAILURES = Number(process.env.GATE_K_MAX_FAILURES || 3);
const DEFAULT_MAX_AI_SPEND = Number(process.env.GATE_K_MAX_AI_SPEND_USD || 2);

export function createAutonomousLoop(deps) {
  const {
    store,
    runOnce = runGateKPipeline,
    logger = console,
  } = deps;

  const timers = new Map();
  const state = new Map(); // portfolioId -> { failures, lastRun, paused, circuitOpen }

  function getState(pid) {
    if (!state.has(pid)) {
      state.set(pid, {
        failures: 0,
        lastRun: 0,
        paused: false,
        circuitOpen: false,
        running: false,
      });
    }
    return state.get(pid);
  }

  function persistAudit(portfolioId, entry) {
    store?.recordDecision?.({
      portfolio_id: portfolioId,
      kind: "gate_k_autonomous",
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  async function tick(portfolioId, tickOpts = {}) {
    const st = getState(portfolioId);
    if (st.paused || st.circuitOpen || st.running) {
      return { ok: false, reason: st.circuitOpen ? "CIRCUIT_OPEN" : "SKIPPED" };
    }
    if (process.env.GATE_K_AUTONOMOUS_LOOP !== "1") {
      return { ok: false, reason: REASON.AUTONOMOUS_DISABLED };
    }

    const now = Date.now();
    const cooldown = tickOpts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (now - st.lastRun < cooldown) {
      return { ok: false, reason: "COOLDOWN" };
    }

    const spend = getSpendState();
    if (Number(spend.spent_usd || 0) >= DEFAULT_MAX_AI_SPEND) {
      st.circuitOpen = true;
      persistAudit(portfolioId, {
        event: "circuit_breaker",
        reason: "MAX_AI_SPEND",
        spend,
      });
      return { ok: false, reason: "MAX_AI_SPEND" };
    }

    st.running = true;
    st.lastRun = now;
    try {
      const result = await runOnce({
        ...tickOpts,
        portfolioId,
        mode: MODE.AUTONOMOUS,
        authenticated: true,
        operatorConfirm: true, // autonomous replaces per-trade confirm
      });

      const signed = !!result.signing || result.enforcement?.signed;
      const failed =
        result.enforcement?.decision === "NO_TRADE" &&
        (result.execution?.reason === "EXECUTE_FAILED" ||
          result.enforcement?.reason_codes?.includes("EXECUTE_FAILED"));

      if (failed) {
        st.failures += 1;
        if (st.failures >= DEFAULT_MAX_FAILURES) {
          st.circuitOpen = true;
          persistAudit(portfolioId, {
            event: "circuit_breaker",
            reason: "MAX_FAILURES",
            failures: st.failures,
          });
        }
      } else if (signed || result.enforcement?.decision === "TRADE") {
        st.failures = 0;
      }

      persistAudit(portfolioId, {
        event: "tick",
        decision: result.enforcement?.decision,
        reason_codes: result.enforcement?.reason_codes,
        signed: !!signed,
      });

      return { ok: true, result };
    } catch (e) {
      st.failures += 1;
      if (st.failures >= DEFAULT_MAX_FAILURES) st.circuitOpen = true;
      persistAudit(portfolioId, {
        event: "tick_error",
        error: String(e?.message || e).slice(0, 300),
      });
      logger.error?.(`[gate-k-auto] ${portfolioId}: ${e?.message || e}`);
      return { ok: false, reason: "TICK_ERROR", error: String(e?.message || e) };
    } finally {
      st.running = false;
    }
  }

  return {
    /** Never called automatically — operator must invoke start. */
    start(portfolioId, opts = {}) {
      if (process.env.GATE_K_AUTONOMOUS_LOOP !== "1") {
        return {
          ok: false,
          reason: REASON.AUTONOMOUS_DISABLED,
          hint: "Set GATE_K_AUTONOMOUS_LOOP=1 after first proof + owner switch",
        };
      }
      if (portfolioId !== FIRST_TEST.portfolio_id && process.env.GATE_K_ALLOW_OTHER_PORTFOLIOS !== "1") {
        return { ok: false, reason: REASON.WRONG_PORTFOLIO };
      }
      const st = getState(portfolioId);
      st.paused = false;
      st.circuitOpen = false;
      st.failures = 0;
      if (timers.has(portfolioId)) clearInterval(timers.get(portfolioId));
      const ms = opts.interval_ms || DEFAULT_INTERVAL_MS;
      const handle = setInterval(() => {
        tick(portfolioId, opts).catch((e) => logger.error?.(String(e)));
      }, ms);
      timers.set(portfolioId, handle);
      persistAudit(portfolioId, { event: "loop_started", interval_ms: ms });
      logger.info?.(`[gate-k-auto] started ${portfolioId} interval=${ms}`);
      return { ok: true, interval_ms: ms };
    },
    stop(portfolioId) {
      if (timers.has(portfolioId)) {
        clearInterval(timers.get(portfolioId));
        timers.delete(portfolioId);
      }
      const st = getState(portfolioId);
      st.paused = true;
      persistAudit(portfolioId, { event: "loop_stopped" });
      return { ok: true };
    },
    pause(portfolioId) {
      const st = getState(portfolioId);
      st.paused = true;
      persistAudit(portfolioId, { event: "loop_paused" });
      return { ok: true };
    },
    resetCircuit(portfolioId) {
      const st = getState(portfolioId);
      st.circuitOpen = false;
      st.failures = 0;
      return { ok: true };
    },
    status(portfolioId) {
      const st = getState(portfolioId);
      return {
        portfolio_id: portfolioId,
        loop_active: timers.has(portfolioId),
        ...st,
        env_enabled: process.env.GATE_K_AUTONOMOUS_LOOP === "1",
      };
    },
    tick,
    /** Restart-safe: report pending gate_k executions */
    recoverPending() {
      const s = store?.read?.() || { executions: {} };
      return Object.entries(s.executions || {})
        .filter(
          ([, v]) =>
            v.kind === "gate_k_ai_trade" &&
            (v.status === "IN_FLIGHT" ||
              v.status === "SIGNED_PENDING_BROADCAST" ||
              v.status === "BROADCAST_PENDING_RECONCILE")
        )
        .map(([key, meta]) => ({ key, ...meta }));
    },
  };
}
