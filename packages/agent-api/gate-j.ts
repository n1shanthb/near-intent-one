/**
 * Gate J — Mandate-aware AI trading intelligence API contract (Chat 2).
 * Strategist/Critic are LLM-backed; Fitter is deterministic. Never treat AI output as signing auth.
 */

export type FitOutcome = "ALLOWED" | "ADAPTED" | "REJECTED";
export type CriticVerdict = "APPROVE" | "REJECT" | "ABSTAIN";
export type FinalDecision =
  | "EXECUTE_DRY_RUN"
  | "EXECUTE"
  | "NO_TRADE"
  | "BLOCKED";

export type GateJStrategistProposal = {
  choice: "TRADE" | "NO_TRADE";
  pair: { origin: string; destination: string };
  direction: string;
  proposed_size_usdc_raw: string;
  min_viable_size_usdc_raw: string;
  thesis: string;
  thesis_id: string;
  expected_benefit: { edge_bps: number; horizon?: string; notes?: string };
  estimated_costs: { fee_bps: number; price_impact_bps: number; notes?: string };
  max_slippage_bps: number;
  invariants: string[];
  evidence: Array<{ source: string; note?: string }>;
  uncertainty: string;
  network: string;
  model: string;
  timestamp: string;
};

export type GateJFitResult = {
  outcome: FitOutcome;
  fitted_proposal: GateJStrategistProposal | null;
  parameters_changed: Array<{
    parameter: string;
    from: unknown;
    to: unknown;
    why: string;
  }>;
  constraints_checked: Array<{ name: string; ok: boolean; [k: string]: unknown }>;
  economic_viability: { ok: boolean; [k: string]: unknown };
  reason_codes: string[];
  operation_id: string;
  policy_hash: string;
  portfolio_id: string;
};

export type GateJCriticReview = {
  verdict: CriticVerdict;
  reasons: string[];
  findings: Record<string, unknown>;
  confidence: number;
  advisory_only: true;
  model: string;
  timestamp: string;
};

export type GateJDecisionTrace = {
  ok: boolean;
  dry_run: true;
  portfolio_id: string;
  summary: {
    fitter_outcome: FitOutcome;
    critic_verdict: CriticVerdict;
    final_decision: FinalDecision;
    may_sign: boolean;
    operation_id: string;
  };
  strategist: {
    ok: boolean;
    proposal: GateJStrategistProposal | null;
    llm: Record<string, unknown>;
  };
  fitter: GateJFitResult;
  critic: GateJCriticReview;
  enforcement: {
    decision: FinalDecision;
    may_sign: boolean;
    dry_run: boolean;
    reason_codes: string[];
    note: string;
  };
  market: Record<string, unknown>;
  note: string;
};

export const GATE_J_ROUTES = {
  health: "GET /v1/gate-j/health",
  market: "GET|POST /v1/gate-j/market",
  scenarios: "GET /v1/gate-j/scenarios",
  strategist: "POST /v1/gate-j/strategist",
  fit: "POST /v1/gate-j/fit",
  critic: "POST /v1/gate-j/critic",
  decide: "POST /v1/gate-j/decide",
  decisions: "GET /v1/gate-j/decisions",
} as const;
