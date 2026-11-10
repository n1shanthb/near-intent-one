/** Gate J UI types — aligned with packages/agent-api/gate-j.ts (Chat 1). */

export type FitVerdict = "ALLOWED" | "ADAPTED" | "REJECTED";

export type FinalDecision =
  | "EXECUTE_DRY_RUN"
  | "EXECUTE"
  | "NO_TRADE"
  | "BLOCKED";

/** How mandate constraints were sourced — never confuse fixture with live policy. */
export type MandateSourceKind =
  | "authoritative_onchain"
  | "recorded_evidence"
  | "demo_fixture"
  | "unavailable";

export type DecisionRunMode = "live_ai" | "fixture" | "recorded";

export type AiStrategyProposal = {
  proposal_id: string;
  asset: string;
  amount: string;
  amount_display?: string;
  thesis: string;
  min_viable_amount: string;
  choice?: "TRADE" | "NO_TRADE";
  model?: string;
  timestamp: string;
  source: "live_llm" | "dry_run_scenario" | "unavailable";
  market_data?: {
    venue?: string;
    as_of?: string;
    freshness_s?: number;
    sources?: string[];
  };
};

export type OwnerMandateView = {
  mandate_epoch: number;
  allowed_assets: string[];
  max_trade_value: string;
  max_pending_exposure: string;
  max_slippage_bps?: number;
  daily_turnover_limit?: string;
  valid_until?: string;
  revoked?: boolean;
  source: MandateSourceKind;
  /** Raw backend source string e.g. on_chain:get_gate_j_mandate */
  source_detail?: string;
  portfolio_id?: string;
  policy_contract?: string;
  policy_hash?: string;
  owner_account?: string;
  as_of?: string;
  freshness_label?: string;
};

export type MandateFitResult = {
  verdict: FitVerdict;
  original_amount: string;
  final_amount: string | null;
  parameters_changed: Array<{ field: string; from: string; to: string }>;
  constraints_satisfied: Array<{ name: string; ok: boolean; detail?: string }>;
  rejection_reasons: string[];
  economically_viable: boolean;
  fitter_id: string;
  timestamp: string;
  mode: "live_api" | "dry_run";
  operation_id?: string;
};

export type RiskCriticVerdict = {
  verdict: "APPROVE" | "REJECT" | "ABSTAIN";
  rationale: string;
  reasons?: string[];
  model?: string;
  timestamp: string;
  source: "live_llm" | "dry_run_scenario" | "unavailable";
  confidence?: number;
};

export type PolicyValidation = {
  mandate_epoch: number;
  constraints: Array<{ name: string; ok: boolean; detail?: string }>;
  near_enforced: true;
  source: "live_view" | "dry_run_scenario" | "unavailable";
};

export type EnforcementView = {
  decision: FinalDecision;
  may_sign: boolean;
  dry_run: boolean;
  reason_codes: string[];
  note: string;
  timestamp?: string;
};

export type DecisionJourneyStageId =
  | "market_research"
  | "ai_strategy"
  | "mandate_fitting"
  | "risk_review"
  | "policy_validation"
  | "execution"
  | "settlement";

export type DecisionJourneyStage = {
  id: DecisionJourneyStageId;
  label: string;
  status: "pending" | "running" | "done" | "blocked" | "skipped" | "enforced";
  detail?: string;
  at?: string;
};

export type GateJModels = {
  researcher?: string | null;
  strategist?: string | null;
  critic?: string | null;
};

export type SafetyStory = {
  headline: string;
  lines: string[];
  blocked_is_success: boolean;
};

export type GateJDecisionRecord = {
  decision_id: string;
  portfolio_id?: string;
  stages: DecisionJourneyStage[];
  proposal: AiStrategyProposal | null;
  mandate: OwnerMandateView | null;
  fit: MandateFitResult | null;
  critic: RiskCriticVerdict | null;
  policy: PolicyValidation | null;
  enforcement: EnforcementView | null;
  models: GateJModels | null;
  safety_story: SafetyStory | null;
  execution: {
    choice: "TRADE" | "NO_TRADE" | "BLOCKED";
    rationale: string;
    dry_run: boolean;
    may_sign: boolean;
    near_tx?: string;
    sepolia_tx?: string;
    explorer_urls?: string[];
  } | null;
  settlement: {
    status: string;
    reconcile_tx?: string;
    verified: boolean;
  } | null;
  market?: Record<string, unknown> | null;
  mode: DecisionRunMode;
  /** @deprecated prefer mode */
  legacy_mode?: "live" | "dry_run";
  note?: string;
  summary?: {
    fitter_outcome?: FitVerdict;
    critic_verdict?: string;
    final_decision?: FinalDecision;
    may_sign?: boolean;
    operation_id?: string;
  };
};

export type GateJScenarioId = "A_ALLOWED" | "B_ADAPTED" | "C_REJECTED";

export type GateJApiScenario = "ALLOWED" | "ADAPTED" | "REJECTED";

export type GateJHistoryEntry = {
  at: string;
  portfolio_id?: string;
  summary?: Record<string, unknown>;
  fitter_outcome?: string;
  operation_id?: string;
};

/** Raw POST /gate-j/decide response (Chat 1). */
export type GateJDecideApiResponse = {
  ok: boolean;
  dry_run?: boolean;
  DRY_RUN?: boolean;
  no_signing?: boolean;
  may_sign?: boolean;
  demo?: boolean;
  demo_mode?: boolean;
  portfolio_id?: string;
  reason?: string;
  mandate_source?: string;
  mandate_epoch?: number;
  policy_hash?: string;
  mandate?: {
    portfolio_id?: string;
    owner_account?: string;
    policy_contract?: string;
    policy_hash?: string;
    mandate_epoch?: number;
    revoked?: boolean;
    paused?: boolean;
    allowed_assets?: string[];
    per_trade_limit_usdc_raw?: string;
    daily_remaining_usdc_raw?: string;
    max_pending_exposure?: string;
    reserved_pending_exposure?: string;
    source?: string;
    as_of?: string;
  };
  summary?: {
    fitter_outcome?: FitVerdict;
    critic_verdict?: "APPROVE" | "REJECT" | "ABSTAIN";
    final_decision?: FinalDecision;
    may_sign?: boolean;
    operation_id?: string;
    models?: GateJModels;
  };
  strategist?: {
    ok?: boolean;
    proposal?: {
      choice?: "TRADE" | "NO_TRADE";
      pair?: { origin?: string; destination?: string };
      proposed_size_usdc_raw?: string;
      proposed_size_usd?: number;
      min_viable_size_usdc_raw?: string;
      min_viable_size_usd?: number;
      thesis?: string;
      thesis_id?: string;
      model?: string;
      timestamp?: string;
      network?: string;
    } | null;
    llm?: { model?: string };
  };
  fitter?: {
    outcome?: FitVerdict;
    fitted_proposal?: { proposed_size_usdc_raw?: string } | null;
    parameters_changed?: Array<{
      parameter?: string;
      field?: string;
      from?: unknown;
      to?: unknown;
      why?: string;
    }>;
    reason_codes?: string[];
    constraints_checked?: Array<{
      name: string;
      ok: boolean;
      detail?: string;
      [k: string]: unknown;
    }>;
    economic_viability?: { ok?: boolean };
    operation_id?: string;
    policy_hash?: string;
  };
  critic?: {
    verdict?: "APPROVE" | "REJECT" | "ABSTAIN";
    reasons?: string[];
    model?: string;
    timestamp?: string;
    confidence?: number;
    advisory_only?: boolean;
  };
  enforcement?: {
    decision?: FinalDecision;
    may_sign?: boolean;
    dry_run?: boolean;
    reason_codes?: string[];
    note?: string;
    timestamp?: string;
  };
  market?: Record<string, unknown>;
  note?: string;
};
