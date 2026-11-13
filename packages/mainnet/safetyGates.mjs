/**
 * Global mainnet transaction broadcast gate (Checkpoint J3 + J8B-0).
 * Default posture: funded_trading / mainnet_broadcast / autonomous_execution = false.
 * Env vars alone NEVER unlock. Only an explicit validated one-shot canary approval may
 * authorize a single operation via opts.canary / opts.canaryUnlock.
 */
import { mainnetAuthGates } from "../networks/profiles.mjs";
import { validateCanaryApproval } from "./canaryOneShot.mjs";

/**
 * Authoritative execution gates for the mainnet agent backend.
 * These three remain false regardless of ambient env flags.
 * Canary unlock is a separate scoped context — it does not flip these flags.
 */
export function mainnetExecutionGates(env = process.env) {
  const auth = mainnetAuthGates(env);
  const observeOnly = env.NIO_MAINNET_OBSERVE_ONLY !== "0"; // default ON
  const unlockAttempted =
    auth.allow_broadcast ||
    auth.allow_sign ||
    env.NIO_FUNDED_TRADING === "1" ||
    env.NIO_AUTONOMOUS_EXECUTION === "1";

  return Object.freeze({
    funded_trading: false,
    mainnet_broadcast_enabled: false,
    autonomous_execution_enabled: false,
    observe_only: observeOnly,
    unlock_attempted_ignored: Boolean(unlockAttempted),
    auth_gates_raw: auth,
    note: "J3 default: broadcast gates hard-false; canary one-shot is separate scoped unlock",
  });
}

/**
 * Resolve optional one-shot canary unlock.
 * @param {object} [opts]
 * @param {object} [opts.canaryUnlock] — pre-validated unlock from buildCanaryUnlockContext
 * @param {string} [opts.operationId] — load+validate approval
 * @param {object} [opts.canary] — alias for canaryUnlock
 */
export function resolveCanaryUnlock(opts = {}, env = process.env) {
  const pre = opts.canaryUnlock || opts.canary || null;
  if (pre?.ok && pre.mode === "one_shot_canary" && pre.operation_id) {
    if (pre.autonomous_execution_enabled === true) {
      return { ok: false, reason: "canary_autonomous_forbidden" };
    }
    return pre;
  }
  if (opts.operationId) {
    return validateCanaryApproval(opts.operationId, {
      env,
      storeDir: opts.storeDir,
      requireQuoteBound: opts.requireQuoteBound === true,
      expected: opts.expected || {},
    });
  }
  return { ok: false, reason: "no_canary_unlock" };
}

/**
 * Hard refuse any mainnet transaction submission unless one-shot canary unlock is valid.
 */
export function assertMainnetBroadcastAllowed(env = process.env, opts = {}) {
  const gates = mainnetExecutionGates(env);
  const canary = resolveCanaryUnlock(opts, env);
  if (canary.ok) {
    return {
      ok: true,
      submitted: false,
      reason: null,
      mode: "one_shot_canary",
      operation_id: canary.operation_id || canary.payload?.operation_id,
      gates: {
        funded_trading: gates.funded_trading,
        mainnet_broadcast_enabled: gates.mainnet_broadcast_enabled,
        autonomous_execution_enabled: false,
        canary_one_shot: true,
      },
      note: "Scoped canary unlock only — not a general trading enable",
    };
  }
  return {
    ok: false,
    submitted: false,
    reason: "mainnet_broadcast_disabled",
    gates: {
      funded_trading: gates.funded_trading,
      mainnet_broadcast_enabled: gates.mainnet_broadcast_enabled,
      autonomous_execution_enabled: gates.autonomous_execution_enabled,
    },
    canary_reason: canary.reason || null,
  };
}

/**
 * Wrap any submitter — never invokes underlying send unless canary unlock is valid.
 */
export async function guardedMainnetSubmit(submitFn, env = process.env, opts = {}) {
  const gate = assertMainnetBroadcastAllowed(env, opts);
  if (!gate.ok) {
    void submitFn;
    return {
      ...gate,
      note: "No RPC send attempted",
    };
  }
  const result = await submitFn();
  return {
    ok: true,
    mode: "one_shot_canary",
    operation_id: gate.operation_id,
    submitted: true,
    result,
  };
}
