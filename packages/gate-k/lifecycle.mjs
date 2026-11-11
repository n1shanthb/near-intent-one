/**
 * Gate K / personal trade execution lifecycle.
 * MPC_SIGNED ≠ SETTLED. Retries never re-sign when signature already exported.
 */

export const LIFECYCLE = Object.freeze({
  AUTHORIZED: "AUTHORIZED",
  QUOTED: "QUOTED",
  FITTER_APPROVED: "FITTER_APPROVED",
  CRITIC_APPROVED: "CRITIC_APPROVED",
  POLICY_APPROVED: "POLICY_APPROVED",
  MPC_SIGNED: "MPC_SIGNED",
  /** Alias retained for store compatibility with prior SIGNED_PENDING_BROADCAST */
  SIGNED_PENDING_BROADCAST: "SIGNED_PENDING_BROADCAST",
  BROADCAST: "BROADCAST",
  CONFIRMED: "CONFIRMED",
  SETTLEMENT_PENDING: "SETTLEMENT_PENDING",
  SETTLED: "SETTLED",
  RECONCILED: "RECONCILED",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
});

/** Terminal success */
export const SUCCESS_STATES = new Set([LIFECYCLE.RECONCILED, "SUCCESS"]);

/** Already signed — must not call request_signature again */
export const SIGNED_STATES = new Set([
  LIFECYCLE.MPC_SIGNED,
  LIFECYCLE.SIGNED_PENDING_BROADCAST,
  LIFECYCLE.BROADCAST,
  LIFECYCLE.CONFIRMED,
  LIFECYCLE.SETTLEMENT_PENDING,
  LIFECYCLE.SETTLED,
  LIFECYCLE.RECONCILED,
  "SUCCESS",
  "BROADCAST_PENDING_RECONCILE",
  "BROADCAST_PENDING_RECEIPT",
]);

/** Worker may advance these without re-signing */
export const BROADCASTABLE = new Set([
  LIFECYCLE.MPC_SIGNED,
  LIFECYCLE.SIGNED_PENDING_BROADCAST,
]);

export const RECEIPT_WAIT = new Set([
  LIFECYCLE.BROADCAST,
  "BROADCAST_PENDING_RECEIPT",
]);

export const SETTLE_WAIT = new Set([
  LIFECYCLE.CONFIRMED,
  LIFECYCLE.SETTLEMENT_PENDING,
  "BROADCAST_PENDING_RECONCILE",
]);

const ORDER = [
  LIFECYCLE.AUTHORIZED,
  LIFECYCLE.QUOTED,
  LIFECYCLE.FITTER_APPROVED,
  LIFECYCLE.CRITIC_APPROVED,
  LIFECYCLE.POLICY_APPROVED,
  LIFECYCLE.MPC_SIGNED,
  LIFECYCLE.BROADCAST,
  LIFECYCLE.CONFIRMED,
  LIFECYCLE.SETTLEMENT_PENDING,
  LIFECYCLE.SETTLED,
  LIFECYCLE.RECONCILED,
];

export function normalizeLifecycleStatus(status) {
  if (status === "SIGNED_PENDING_BROADCAST") return LIFECYCLE.MPC_SIGNED;
  if (status === "SUCCESS") return LIFECYCLE.RECONCILED;
  if (status === "BROADCAST_PENDING_RECEIPT") return LIFECYCLE.BROADCAST;
  if (status === "BROADCAST_PENDING_RECONCILE") return LIFECYCLE.SETTLEMENT_PENDING;
  return status;
}

export function canTransition(from, to) {
  if (to === LIFECYCLE.FAILED || to === LIFECYCLE.BLOCKED) return true;
  const a = normalizeLifecycleStatus(from);
  const b = normalizeLifecycleStatus(to);
  if (a === b) return true;
  const ia = ORDER.indexOf(a);
  const ib = ORDER.indexOf(b);
  if (ia < 0 || ib < 0) return false;
  return ib === ia + 1 || ib > ia; // allow skip-forward only for recovery coalescing
}

export function alreadySigned(status) {
  return SIGNED_STATES.has(status) || SIGNED_STATES.has(normalizeLifecycleStatus(status));
}

export function isTerminalSuccess(status) {
  return SUCCESS_STATES.has(status) || normalizeLifecycleStatus(status) === LIFECYCLE.RECONCILED;
}
