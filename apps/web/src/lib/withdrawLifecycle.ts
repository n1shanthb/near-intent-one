import type {
  WithdrawLifecycleStage,
  WithdrawReceipt,
} from "../types/gateI";
import { WITHDRAW_LIFECYCLE_STAGES } from "../types/gateI";

/** Recorded Gate I evidence: NEAR owner auth while paused — Signed only. */
export const RECORDED_WITHDRAW_SIGNED = {
  near_tx: "8mvQe6SkkR8pze79kF5jy6AMEimX3FFZJJHKEw7yPsCJ",
  explorer:
    "https://testnet.nearblocks.io/txns/8mvQe6SkkR8pze79kF5jy6AMEimX3FFZJJHKEw7yPsCJ",
  stage: "Signed" as const,
  note: "Historical NEAR withdraw_signed alone was Signed only.",
};

/** Closure PASS (2026-11-10): Sepolia delivery + recipient balance. */
export const RECORDED_WITHDRAW_RECEIVED = {
  sepolia_tx:
    "0x2d11b9a650b92f422c39edbe89002f4722598adf44367e0f6a79bcd89a33408d",
  explorer:
    "https://sepolia.etherscan.io/tx/0x2d11b9a650b92f422c39edbe89002f4722598adf44367e0f6a79bcd89a33408d",
  recipient: "0x9950ce47498ab3a83b278879aa9f0e477346ac39",
  amount: "0.1 USDC",
  stage: "Received" as const,
  note: "GATE_I.md B2 PASS — status 0x1 Transfer 0.1 USDC to approved recipient.",
};

export const RECORDED_TRADE_PASS = {
  sepolia_tx:
    "0x26b9c08a722004a1ef548bfe71cb8f4efd7af06df8de5a0e33705c744ae16e54",
  explorer:
    "https://sepolia.etherscan.io/tx/0x26b9c08a722004a1ef548bfe71cb8f4efd7af06df8de5a0e33705c744ae16e54",
  note: "GATE_I.md B3 PASS — Tidepool SUCCESS + reconcile.",
};

export function stageReached(
  current: WithdrawLifecycleStage | null,
  target: WithdrawLifecycleStage
): boolean {
  if (!current) return false;
  return (
    WITHDRAW_LIFECYCLE_STAGES.indexOf(current) >=
    WITHDRAW_LIFECYCLE_STAGES.indexOf(target)
  );
}

/**
 * Never promote Signed-only or submitted-without-sepolia to Received.
 */
export function honestLifecycleFromReceipt(
  receipt: WithdrawReceipt | null,
  deliveryEnabled: boolean
): WithdrawLifecycleStage | null {
  if (!receipt) return null;
  if (receipt.status === "blocked") return "Requested";
  if (receipt.status === "pending") return "Authorized";
  if (receipt.status === "failed" || receipt.status === "refunded") {
    return "Signed";
  }
  if (receipt.status === "submitted") {
    return receipt.sepolia_tx ? "Broadcast" : "Signed";
  }
  if (receipt.status === "settled") {
    if (
      deliveryEnabled &&
      receipt.destination_balance_confirmed &&
      receipt.sepolia_tx
    ) {
      return "Received";
    }
    if (receipt.sepolia_tx) return "Confirmed";
    return "Signed";
  }
  return "Requested";
}
