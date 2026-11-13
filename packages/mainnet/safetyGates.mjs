/**
 * Global mainnet transaction broadcast gate (Checkpoint J3 + J8B-0/1).
 * Default posture: funded_trading / mainnet_broadcast / autonomous_execution = false.
 * Env vars alone NEVER unlock.
 *
 * Canary unlock ALWAYS re-validates approval from disk by operation_id.
 * Caller-constructed "prevalidated" unlock objects are rejected unless they
 * include operation_id and pass a fresh disk validation.
 */
import { mainnetAuthGates } from "../networks/profiles.mjs";
import {
  validateCanaryApproval,
  validateExecutableApproval,
} from "./canaryOneShot.mjs";

export function mainnetExecutionGates(env = process.env) {
  const auth = mainnetAuthGates(env);
  const observeOnly = env.NIO_MAINNET_OBSERVE_ONLY !== "0";
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
    note: "J3 default hard-false; canary one-shot requires fresh disk validation",
  });
}

/**
 * Resolve canary unlock — ALWAYS re-loads approval from disk.
 * Ignores opaque prevalidated objects that lack a verifiable operation_id.
 */
export function resolveCanaryUnlock(opts = {}, env = process.env) {
  const opId =
    opts.operationId ||
    opts.canaryUnlock?.operation_id ||
    opts.canary?.operation_id ||
    null;
  if (!opId) {
    return { ok: false, reason: "no_canary_unlock" };
  }
  // Reject trusting caller flags — re-validate MAC/expiry/bindings from disk.
  const validate =
    opts.allowRecovery === true
      ? validateExecutableApproval
      : validateCanaryApproval;
  const v = validate(opId, {
    env,
    storeDir: opts.storeDir,
    requireQuoteBound: opts.requireQuoteBound !== false,
    expected: opts.expected || {},
    nowMs: opts.nowMs,
    allowRecovery: opts.allowRecovery === true,
  });
  if (!v.ok) return v;
  if (opts.canaryUnlock?.autonomous_execution_enabled === true) {
    return { ok: false, reason: "canary_autonomous_forbidden" };
  }
  return {
    ok: true,
    mode: v.is_recovery ? "one_shot_canary_recovery" : "one_shot_canary",
    operation_id: opId,
    payload: v.payload,
    record: v.record,
    allows_sign: true,
    allows_broadcast: true,
    autonomous_execution_enabled: false,
    freshly_validated: true,
    is_recovery: Boolean(v.is_recovery),
  };
}

export function assertMainnetBroadcastAllowed(env = process.env, opts = {}) {
  const gates = mainnetExecutionGates(env);
  const canary = resolveCanaryUnlock(opts, env);
  if (canary.ok) {
    return {
      ok: true,
      submitted: false,
      reason: null,
      mode: "one_shot_canary",
      operation_id: canary.operation_id,
      freshly_validated: true,
      gates: {
        funded_trading: gates.funded_trading,
        mainnet_broadcast_enabled: gates.mainnet_broadcast_enabled,
        autonomous_execution_enabled: false,
        canary_one_shot: true,
      },
      note: "Scoped canary unlock only — revalidated from disk",
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

export async function guardedMainnetSubmit(submitFn, env = process.env, opts = {}) {
  const gate = assertMainnetBroadcastAllowed(env, opts);
  if (!gate.ok) {
    void submitFn;
    return { ...gate, note: "No RPC send attempted" };
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
