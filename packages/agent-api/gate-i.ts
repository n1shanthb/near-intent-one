/**
 * Gate I — multi-user portfolio + deposit/withdraw + hosted agent API contract.
 * Chat 1 implements the backend. Product UI consumes these shapes only.
 * Do not invent balances, deploy txs, or withdrawal SUCCESS in the frontend.
 */

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
  intents_signer_id: string | null; // EVM / intents identity
  created_at: string;
  deploy_status: "pending" | "funding" | "deploying" | "ready" | "failed";
  deploy_txs: Array<{ label: string; tx_hash: string }>;
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

export type WithdrawReceipt = {
  status: "pending" | "submitted" | "settled" | "failed" | "refunded" | "blocked";
  tx_hash?: string;
  explorer_url?: string;
  reason?: string;
};

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
  /** Client-suggested slug; server may rewrite for uniqueness */
  preferred_portfolio_id?: string;
};

export type CreatePortfolioResponse =
  | {
      status: "ready" | "pending_owner_signature" | "pending_deploy";
      portfolio: PortfolioRecord;
      next_action?: string;
    }
  | { status: "blocked"; reason: string };

/**
 * Product unlock flags (frontend):
 * - VITE_GATE_I_API_BASE → OCI http://129.225.72.169:8787/v1 (or local)
 * - VITE_GATE_I_WITHDRAW_PROVEN=true authorized 2026-11-10 (GATE_I.md B2 PASS)
 * - Per-receipt: NEAR withdraw_signed alone = Signed; Sepolia+dest = Received
 */
export const GATE_I_ROUTES = {
  health: "GET /v1/health",
  createPortfolio: "POST /v1/portfolios",
  getPortfolio: "GET /v1/portfolios/:id",
  listBalances: "GET /v1/portfolios/:id/balances",
  createDeposit: "POST /v1/portfolios/:id/deposits",
  quoteWithdraw: "POST /v1/portfolios/:id/withdrawals/quote",
  submitWithdraw: "POST /v1/portfolios/:id/withdrawals",
  agentState: "GET /v1/portfolios/:id/agent",
  agentStart: "POST /v1/portfolios/:id/agent/start",
  agentStop: "POST /v1/portfolios/:id/agent/stop",
  setPolicy: "POST /v1/portfolios/:id/policy",
  revoke: "POST /v1/portfolios/:id/revoke",
  pause: "POST /v1/portfolios/:id/pause",
} as const;
