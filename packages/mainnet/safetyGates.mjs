/**
 * Global mainnet transaction broadcast gate (Checkpoint J3).
 * Hard posture: funded_trading / mainnet_broadcast / autonomous_execution = false.
 * Blocks ALL mainnet transaction submission — not only 1Click swaps.
 */
import { mainnetAuthGates } from "../networks/profiles.mjs";

/**
 * Authoritative execution gates for the mainnet agent backend.
 * Until a later checkpoint explicitly unlocks funded trading, these three
 * remain false regardless of ambient env flags.
 */
export function mainnetExecutionGates(env = process.env) {
  const auth = mainnetAuthGates(env);
  const observeOnly = env.NIO_MAINNET_OBSERVE_ONLY !== "0"; // default ON
  // Even if operator sets unlock env vars early, J3 code refuses to honor them.
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
    note: "J3: broadcast gates hard-false; no mainnet tx submission",
  });
}

/**
 * Hard refuse any mainnet transaction submission.
 * @returns {{ ok: false, reason: string, gates: object, submitted: false }}
 */
export function assertMainnetBroadcastAllowed(env = process.env) {
  const gates = mainnetExecutionGates(env);
  return {
    ok: false,
    submitted: false,
    reason: "mainnet_broadcast_disabled",
    gates: {
      funded_trading: gates.funded_trading,
      mainnet_broadcast_enabled: gates.mainnet_broadcast_enabled,
      autonomous_execution_enabled: gates.autonomous_execution_enabled,
    },
  };
}

/**
 * Wrap any submitter — never invokes the underlying send on mainnet in J3.
 */
export async function guardedMainnetSubmit(submitFn, env = process.env) {
  const gate = assertMainnetBroadcastAllowed(env);
  // Intentionally do not call submitFn.
  void submitFn;
  return {
    ...gate,
    note: "No RPC send attempted",
  };
}
