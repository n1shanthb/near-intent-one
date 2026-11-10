/** Mirrors packages/agent-api/gate-i.ts — keep in sync with Chat 1. */

export type GateIStatus = "available" | "unavailable" | "degraded";
export type AuthMode = "ledger" | "near_wallet" | "demo";
export type PortfolioId = string;

export type PortfolioRecord = {
  portfolio_id: PortfolioId;
  owner_account: string;
  policy_contract: string;
  agent_account: string | null;
  reconciler_account: string | null;
  derivation_path: string;
  intents_signer_id: string | null;
  created_at: string;
  deploy_status: "pending" | "funding" | "deploying" | "ready" | "failed";
  deploy_txs: Array<{ label: string; tx_hash?: string }>;
  network: "testnet";
};

export type BalanceSlice = {
  chain: string;
  asset: string;
  amount: string;
  location: "wallet" | "policy_near" | "mpc_evm" | "intents";
  verification: "live_read" | "unavailable";
};

export type DepositIntent = {
  portfolio_id: PortfolioId;
  chain: string;
  asset: string;
  deposit_address: string;
  memo?: string;
  status: "awaiting_funds" | "detected" | "credited" | "failed";
  tx_hash?: string;
};

export type WithdrawRequest = {
  portfolio_id: PortfolioId;
  chain: string;
  asset: string;
  amount: string;
  destination: string;
};

export type WithdrawQuote = {
  ok: boolean;
  fee_estimate?: string;
  destination_valid: boolean;
  requires_owner_signature: true;
  blocked_reason?: string;
};

/** API coarse status — never map Signed-only to Received. */
export type WithdrawReceiptStatus =
  | "pending"
  | "submitted"
  | "settled"
  | "failed"
  | "refunded"
  | "blocked";

export type WithdrawReceipt = {
  status: WithdrawReceiptStatus;
  tx_hash?: string;
  explorer_url?: string;
  reason?: string;
  /** Optional delivery proof from Chat 1 — required for Received */
  destination_balance_confirmed?: boolean;
  sepolia_tx?: string;
};

/**
 * Exact product lifecycle. `withdraw_signed` NEAR authorization = Signed only.
 * Received requires confirmed broadcast + destination funds evidence.
 */
export type WithdrawLifecycleStage =
  | "Requested"
  | "Authorized"
  | "Signed"
  | "Broadcast"
  | "Confirmed"
  | "Received";

export const WITHDRAW_LIFECYCLE_STAGES: WithdrawLifecycleStage[] = [
  "Requested",
  "Authorized",
  "Signed",
  "Broadcast",
  "Confirmed",
  "Received",
];

export type AgentRuntimeState = {
  portfolio_id: PortfolioId;
  running: boolean;
  strategy_id: string | null;
  last_decision: {
    choice: "TRADE" | "NO_TRADE";
    rationale: string;
    timestamp: string;
  } | null;
  last_settlement: {
    operation_id: string;
    status: string;
    origin_tx?: string;
    near_tx?: string;
  } | null;
  source: "live_gate_i" | "unavailable";
};

export type CreatePortfolioRequest = {
  owner_account: string;
  auth_mode: AuthMode;
  preferred_portfolio_id?: string;
};

export type CreatePortfolioResponse =
  | {
      status: "ready" | "pending_owner_signature" | "pending_deploy";
      portfolio: PortfolioRecord;
      next_action?: string;
    }
  | { status: "blocked"; reason: string };

export type GateIHealthPayload = {
  ok?: boolean;
  network?: string;
  services?: Record<string, unknown>;
  pending_recoveries?: number;
  /** Chat 1 may set when Sepolia delivery + destination balance are proven */
  withdraw_delivery_proven?: boolean;
};
