/**
 * Gate J client — hosted HTTPS API only for LLM.
 * Never calls OpenRouter from the browser. Never fabricates live AI results.
 */
import {
  GATE_J_SCENARIOS,
  fitMandate,
  runScenario,
  usdcDisplay,
  type ScenarioId,
} from "../lib/mandateFitter";
import type {
  DecisionRunMode,
  FinalDecision,
  GateJApiScenario,
  GateJDecideApiResponse,
  GateJDecisionRecord,
  GateJHistoryEntry,
  GateJModels,
  GateJScenarioId,
  MandateFitResult,
  MandateSourceKind,
  SafetyStory,
} from "../types/gateJ";

const SCENARIO_API: Record<GateJScenarioId, GateJApiScenario> = {
  A_ALLOWED: "ALLOWED",
  B_ADAPTED: "ADAPTED",
  C_REJECTED: "REJECTED",
};

/**
 * Prefer same-origin BFF `/api/v1` (server injects GATE_I_API_KEY).
 * Never put privileged API keys in VITE_*.
 */
const base = () =>
  (import.meta.env.VITE_GATE_I_API_BASE as string | undefined)?.replace(/\/$/, "") ??
  "";

function usesBff(): boolean {
  const root = base();
  return root === "/api/v1" || root.endsWith("/api/v1");
}

async function getJson<T>(
  path: string,
  init?: RequestInit
): Promise<{ ok: true; data: T } | { ok: false; status: number; data: Record<string, unknown> }> {
  const root = base();
  if (!root) throw new Error("VITE_GATE_I_API_BASE unset");
  const res = await fetch(`${root}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { ok: false, status: res.status, data: body };
  return { ok: true, data: body as T };
}

/** Enable only after hosted API + SPA integration verified. */
export function isOnchainMandateHydrated(): boolean {
  return import.meta.env.VITE_GATE_J_ONCHAIN_MANDATE === "true";
}

/** Funded / authorize-trade stays off until on-chain mandate flag is set. */
export function authorizationActionsEnabled(): boolean {
  return isOnchainMandateHydrated();
}

export function authModeLabel(): string {
  return usesBff()
    ? "same-origin BFF (server API key; not in Vite)"
    : "direct API (public GETs only; mutations need Chat 1 owner session / BFF)";
}

export async function gateJHealth(): Promise<{
  available: boolean;
  detail: string;
  llm?: Record<string, unknown>;
  auth_required?: boolean;
}> {
  if (!base()) {
    return {
      available: false,
      detail: "Gate I/J API base unset — fixture Fitter only.",
    };
  }
  try {
    const res = await getJson<{
      ok?: boolean;
      llm?: Record<string, unknown>;
      dry_run_default?: boolean;
      reason?: string;
    }>("/gate-j/health");
    if (res.ok && res.data.ok) {
      const llm = res.data.llm ?? {};
      const configured =
        typeof llm === "object" && llm && "configured" in llm
          ? Boolean((llm as { configured?: boolean }).configured)
          : true;
      return {
        available: true,
        detail: configured
          ? "Gate J intelligence API online (OpenRouter server-side)"
          : "Gate J online — LLM key not configured on host",
        llm: llm as Record<string, unknown>,
      };
    }
    return {
      available: false,
      detail:
        typeof res.data.reason === "string"
          ? `Gate J not hosted yet (${res.data.reason}). Fixture Fitter available.`
          : "Gate J routes not hosted yet (Chat 1). Fixture Fitter available.",
    };
  } catch (e) {
    return {
      available: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function fetchGateJHistory(
  limit = 20
): Promise<GateJHistoryEntry[]> {
  const health = await gateJHealth();
  if (!health.available) return [];
  const res = await getJson<{ ok?: boolean; decisions?: GateJHistoryEntry[] }>(
    `/gate-j/decisions`
  );
  if (!res.ok) return [];
  return (res.data.decisions ?? []).slice(0, limit);
}

function shortModel(id?: string | null): string {
  if (!id) return "the model";
  if (id.includes("claude")) return "Claude";
  if (id.includes("gpt")) return "GPT";
  if (id.includes("gemini")) return "Gemini";
  const last = id.split("/").pop() ?? id;
  return last;
}

export function buildSafetyStory(input: {
  strategistChoice?: string | null;
  strategistModel?: string | null;
  criticVerdict?: string | null;
  criticModel?: string | null;
  fitterOutcome?: string | null;
  finalDecision?: FinalDecision | string | null;
  maySign?: boolean;
}): SafetyStory {
  const strat = shortModel(input.strategistModel);
  const critic = shortModel(input.criticModel);
  const choice = input.strategistChoice ?? "—";
  const verdict = input.criticVerdict ?? "—";
  const fit = input.fitterOutcome ?? "—";
  const final = input.finalDecision ?? "—";
  const may = input.maySign ?? false;

  // Hosted pattern: Strategist NO_TRADE → Fitter REJECTED → Critic ABSTAIN → BLOCKED
  if (choice === "NO_TRADE") {
    const criticLine =
      verdict === "ABSTAIN"
        ? `${critic} abstained (nothing executable to approve).`
        : verdict === "REJECT"
          ? `${critic} rejected the empty / unsupported path.`
          : `${critic} verdict: ${verdict}.`;
    return {
      headline:
        `${strat} declined an inadequately supported trade. NIO checked the owner's mandate. ` +
        `${criticLine} Enforcement BLOCKED signing.`,
      lines: [
        `${strat} chose NO_TRADE — inadequately supported.`,
        `Deterministic Fitter: ${fit}.`,
        criticLine,
        `Enforcement ${final} · may_sign=${String(may)}.`,
      ],
      blocked_is_success: true,
    };
  }

  if (choice === "TRADE" && verdict === "REJECT") {
    return {
      headline:
        `${strat} proposed a trade. NIO checked the owner's mandate. ` +
        `${critic} independently rejected the proposal. NIO blocked signing.`,
      lines: [
        `${strat} proposed a trade.`,
        "NIO checked the owner's mandate.",
        `${critic} independently rejected the proposal.`,
        "NIO blocked signing.",
      ],
      blocked_is_success: true,
    };
  }

  if (choice === "TRADE" && verdict === "ABSTAIN") {
    return {
      headline:
        `${strat} proposed a trade. ${critic} abstained. NIO blocked signing (fail closed).`,
      lines: [
        `${strat} proposed a trade.`,
        `Fitter: ${fit}.`,
        `${critic} abstained.`,
        `Enforcement ${final} · may_sign=${String(may)}.`,
      ],
      blocked_is_success: true,
    };
  }

  return {
    headline: `Pipeline: Strategist ${choice} · Fitter ${fit} · Critic ${verdict} · ${final} · may_sign=${String(may)}`,
    lines: [
      `Strategist: ${choice} (${strat})`,
      `Fitter: ${fit}`,
      `Critic: ${verdict} (${critic})`,
      `Enforcement: ${final} · may_sign=${String(may)}`,
    ],
    blocked_is_success: may === false,
  };
}

function classifyMandateSource(raw?: string | null): MandateSourceKind {
  if (!raw) return "unavailable";
  if (raw.startsWith("on_chain")) return "authoritative_onchain";
  if (raw.includes("fixture") || raw.includes("scenario")) return "demo_fixture";
  if (raw.includes("recorded") || raw.includes("evidence")) return "recorded_evidence";
  return "demo_fixture";
}

function freshnessLabel(asOf?: string | null): string | undefined {
  if (!asOf) return undefined;
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return asOf;
  const ageS = Math.max(0, Math.round((Date.now() - t) / 1000));
  return `${asOf} · age ${ageS}s`;
}

function usdRawFromMaybe(
  raw?: string,
  usd?: number
): string {
  if (raw) return String(raw);
  if (typeof usd === "number") return String(Math.round(usd * 1e6));
  return "0";
}

/** Map Chat 1 decide payload → UI journey record. */
export function mapDecideToRecord(
  api: GateJDecideApiResponse,
  opts: {
    mode: DecisionRunMode;
    mandateSource: MandateSourceKind;
    portfolioId?: string;
  }
): GateJDecisionRecord {
  const now = new Date().toISOString();
  const proposal = api.strategist?.proposal;
  const models: GateJModels = {
    researcher: api.summary?.models?.researcher ?? null,
    strategist:
      api.summary?.models?.strategist ??
      api.strategist?.llm?.model ??
      proposal?.model ??
      null,
    critic:
      api.summary?.models?.critic ?? api.critic?.model ?? null,
  };
  const finalDecision =
    api.enforcement?.decision ??
    api.summary?.final_decision ??
    "BLOCKED";
  const maySign = api.enforcement?.may_sign ?? api.summary?.may_sign ?? false;
  const fitterOutcome =
    api.fitter?.outcome ?? api.summary?.fitter_outcome ?? "REJECTED";
  const criticVerdict =
    api.critic?.verdict ?? api.summary?.critic_verdict ?? "ABSTAIN";

  const original = usdRawFromMaybe(
    proposal?.proposed_size_usdc_raw,
    proposal?.proposed_size_usd
  );
  const minViable = usdRawFromMaybe(
    proposal?.min_viable_size_usdc_raw,
    proposal?.min_viable_size_usd
  );
  const fittedRaw =
    api.fitter?.fitted_proposal?.proposed_size_usdc_raw ??
    (fitterOutcome === "REJECTED" ? null : original);

  const params = (api.fitter?.parameters_changed ?? []).map((p) => ({
    field: String(p.parameter ?? p.field ?? "param"),
    from: String(p.from ?? ""),
    to: String(p.to ?? ""),
  }));

  const constraints = (api.fitter?.constraints_checked ?? []).map((c) => ({
    name: c.name,
    ok: Boolean(c.ok),
    detail: typeof c.detail === "string" ? c.detail : undefined,
  }));

  const fit: MandateFitResult = {
    verdict: fitterOutcome,
    original_amount: original,
    final_amount: fittedRaw,
    parameters_changed: params,
    constraints_satisfied: constraints,
    rejection_reasons: api.fitter?.reason_codes ?? [],
    economically_viable: Boolean(api.fitter?.economic_viability?.ok),
    fitter_id: "deterministic_v1",
    timestamp: now,
    mode: opts.mode === "live_ai" ? "live_api" : "dry_run",
    operation_id: api.fitter?.operation_id ?? api.summary?.operation_id,
  };

  const market = api.market as
    | {
        as_of?: string;
        venue?: string;
        freshness_s?: number;
        sources?: string[];
        timestamp?: string;
      }
    | undefined;

  const safety = buildSafetyStory({
    strategistChoice: proposal?.choice,
    strategistModel: models.strategist,
    criticVerdict,
    criticModel: models.critic,
    fitterOutcome,
    finalDecision,
    maySign,
  });

  const blockedOk = finalDecision === "BLOCKED" && safety.blocked_is_success;

  const stages = [
    {
      id: "market_research" as const,
      label: "Market Research",
      status: "done" as const,
      detail: models.researcher
        ? `Researcher ${models.researcher}`
        : opts.mode === "fixture"
          ? "Fixture market snapshot (not live feeds)."
          : "Market snapshot from API.",
      at: market?.as_of ?? market?.timestamp ?? now,
    },
    {
      id: "ai_strategy" as const,
      label: "AI Strategy Proposal",
      status: "done" as const,
      detail: proposal
        ? `${proposal.choice ?? "—"} · ${models.strategist ?? proposal.model ?? "strategist"} · ${usdcDisplay(original)}`
        : "No strategist proposal",
      at: proposal?.timestamp ?? now,
    },
    {
      id: "mandate_fitting" as const,
      label: "Mandate Fitting",
      status: "done" as const,
      detail: `Deterministic Fitter → ${fitterOutcome} (mandate: ${opts.mandateSource})`,
      at: now,
    },
    {
      id: "risk_review" as const,
      label: "Independent Risk Review",
      status:
        criticVerdict === "REJECT" || criticVerdict === "ABSTAIN"
          ? ("blocked" as const)
          : ("done" as const),
      detail: `${criticVerdict} · ${models.critic ?? "critic"}`,
      at: api.critic?.timestamp ?? now,
    },
    {
      id: "policy_validation" as const,
      label: "NEAR Policy Validation",
      status: "done" as const,
      detail: "NEAR remains the enforcement boundary. AI cannot override policy.",
      at: now,
    },
    {
      id: "execution" as const,
      label: "Execution / Enforcement",
      status: blockedOk ? ("enforced" as const) : ("done" as const),
      detail: blockedOk
        ? `BLOCKED (correctly enforced) · may_sign=${maySign}`
        : `${finalDecision} · may_sign=${maySign} · dry_run=${api.dry_run !== false}`,
      at: api.enforcement?.timestamp ?? now,
    },
    {
      id: "settlement" as const,
      label: "Settlement Verification",
      status: "skipped" as const,
      detail: "Funded execution disabled — no on-chain settlement.",
      at: now,
    },
  ];

  const execChoice: "TRADE" | "NO_TRADE" | "BLOCKED" =
    finalDecision === "BLOCKED"
      ? "BLOCKED"
      : finalDecision === "NO_TRADE"
        ? "NO_TRADE"
        : proposal?.choice === "TRADE"
          ? "TRADE"
          : "NO_TRADE";

  return {
    decision_id:
      api.summary?.operation_id ??
      api.fitter?.operation_id ??
      `gate-j-${Date.now()}`,
    portfolio_id: opts.portfolioId ?? api.portfolio_id,
    stages,
    proposal: proposal
      ? {
          proposal_id: proposal.thesis_id ?? "strategist",
          asset: proposal.pair?.origin ?? "USDC",
          amount: original,
          amount_display: usdcDisplay(original),
          thesis: proposal.thesis ?? "",
          min_viable_amount: minViable,
          choice: proposal.choice,
          model: models.strategist ?? proposal.model,
          timestamp: proposal.timestamp ?? now,
          source: opts.mode === "live_ai" ? "live_llm" : "dry_run_scenario",
          market_data: {
            venue: market?.venue ?? proposal.network,
            as_of: market?.as_of ?? market?.timestamp,
            freshness_s: market?.freshness_s,
            sources: market?.sources,
          },
        }
      : null,
    mandate: (() => {
      const rawSource =
        api.mandate_source ?? api.mandate?.source ?? null;
      const source =
        opts.mode === "fixture"
          ? ("demo_fixture" as MandateSourceKind)
          : classifyMandateSource(rawSource) !== "unavailable"
            ? classifyMandateSource(rawSource)
            : opts.mandateSource;
      const asOf = api.mandate?.as_of;
      return {
        mandate_epoch: Number(
          api.mandate_epoch ?? api.mandate?.mandate_epoch ?? 0
        ),
        allowed_assets: api.mandate?.allowed_assets ?? ["USDC", "wNEAR"],
        max_trade_value:
          api.mandate?.per_trade_limit_usdc_raw ?? "20000000",
        max_pending_exposure:
          api.mandate?.max_pending_exposure ?? "100000000",
        source,
        source_detail: rawSource ?? undefined,
        portfolio_id:
          api.mandate?.portfolio_id ??
          opts.portfolioId ??
          api.portfolio_id,
        policy_contract: api.mandate?.policy_contract,
        policy_hash: api.policy_hash ?? api.mandate?.policy_hash,
        owner_account: api.mandate?.owner_account,
        as_of: asOf,
        freshness_label: freshnessLabel(asOf),
        revoked: api.mandate?.revoked,
      };
    })(),
    fit,
    critic: {
      verdict: criticVerdict,
      rationale: (api.critic?.reasons ?? []).join("; ") || String(criticVerdict),
      reasons: api.critic?.reasons,
      model: models.critic ?? api.critic?.model,
      timestamp: api.critic?.timestamp ?? now,
      source: opts.mode === "live_ai" ? "live_llm" : "dry_run_scenario",
      confidence: api.critic?.confidence,
    },
    policy: {
      mandate_epoch: Number(
        api.mandate_epoch ?? api.mandate?.mandate_epoch ?? 0
      ),
      constraints,
      near_enforced: true,
      source: opts.mode === "live_ai" ? "live_view" : "dry_run_scenario",
    },
    enforcement: {
      decision: finalDecision,
      may_sign: maySign,
      dry_run: api.dry_run !== false,
      reason_codes: api.enforcement?.reason_codes ?? [],
      note:
        api.enforcement?.note ??
        api.note ??
        "LLM/Fitter outputs are not signing authorization",
      timestamp: api.enforcement?.timestamp,
    },
    models,
    safety_story: safety,
    execution: {
      choice: execChoice,
      rationale: blockedOk
        ? `Correctly enforced BLOCKED — ${safety.headline}`
        : `${finalDecision}: may_sign=${maySign}`,
      dry_run: api.dry_run !== false,
      may_sign: maySign,
    },
    settlement: {
      status: "skipped_dry_run",
      verified: false,
    },
    market: api.market ?? null,
    mode: opts.mode,
    note: api.note,
    summary: {
      fitter_outcome: fitterOutcome,
      critic_verdict: criticVerdict,
      final_decision: finalDecision,
      may_sign: maySign,
      operation_id: api.summary?.operation_id,
    },
  };
}

/** LIVE AI / DRY RUN — OpenRouter only via backend; never client mandate. */
export async function runLiveAiDecide(opts: {
  portfolioId: string;
  claimedOwner: string;
}): Promise<GateJDecisionRecord> {
  if (!opts.portfolioId) {
    throw new Error("portfolio_id required for live AI (on-chain mandate hydration)");
  }
  if (!opts.claimedOwner) {
    throw new Error("Connect the portfolio owner wallet before live AI");
  }

  const health = await gateJHealth();
  if (!health.available) {
    throw new Error(
      `Live AI unavailable: ${health.detail}. Need GET /v1/gate-j/health + authenticated decide.`
    );
  }

  // Never send client-defined mandate constraints — backend hydrates on-chain.
  const body = {
    portfolio_id: opts.portfolioId,
    claimed_owner: opts.claimedOwner,
    use_llm: true,
    dry_run: true,
    allow_execute: false,
  };

  const res = await getJson<GateJDecideApiResponse>("/gate-j/decide", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const reason =
      typeof res.data.reason === "string"
        ? res.data.reason
        : `HTTP ${res.status}`;
    if (res.status === 401) {
      throw new Error(
        "Unauthorized — use same-origin /api/v1 BFF (server GATE_I_API_KEY) or Chat 1 owner session. Never put API keys in VITE_*."
      );
    }
    throw new Error(`Live decide failed: ${reason}`);
  }
  if (!res.data.ok) {
    throw new Error(
      `Live decide rejected: ${res.data.reason ?? "unknown"}`
    );
  }

  const source = classifyMandateSource(
    res.data.mandate_source ?? res.data.mandate?.source
  );
  return mapDecideToRecord(res.data, {
    mode: "live_ai",
    mandateSource:
      source === "unavailable" ? "authoritative_onchain" : source,
    portfolioId: opts.portfolioId,
  });
}

/** Recorded hosted OpenRouter evidence for judge demo when live call blocked. */
export function loadHostedEvidenceRecord(): GateJDecisionRecord | null {
  // Inlined summary from evidence/live/gate-j-hosted-live-llm.json — not a fabricated LLM call.
  const api: GateJDecideApiResponse = {
    ok: true,
    dry_run: true,
    DRY_RUN: true,
    no_signing: true,
    portfolio_id: "i-a-a4e7",
    mandate_source: "on_chain:get_gate_j_mandate",
    mandate_epoch: 3,
    policy_hash: "gate-i-closure-v1",
    mandate: {
      portfolio_id: "i-a-a4e7",
      owner_account: "nio-i-a4e7-a-owner.testnet",
      policy_contract: "policy.nio-i-a4e7-a-owner.testnet",
      policy_hash: "gate-i-closure-v1",
      mandate_epoch: 3,
      allowed_assets: ["USDC", "wNEAR"],
      per_trade_limit_usdc_raw: "100000000",
      max_pending_exposure: "100000000",
      source: "on_chain:get_gate_j_mandate",
      as_of: "2026-11-10T09:10:47.331Z",
    },
    summary: {
      fitter_outcome: "REJECTED",
      critic_verdict: "ABSTAIN",
      final_decision: "BLOCKED",
      may_sign: false,
      operation_id: "gate-j-94f0cfa0",
      models: {
        researcher: "google/gemini-2.5-flash",
        strategist: "anthropic/claude-sonnet-4.6",
        critic: "openai/gpt-5.2",
      },
    },
    strategist: {
      ok: true,
      proposal: {
        choice: "NO_TRADE",
        pair: { origin: "USDC", destination: "wNEAR" },
        proposed_size_usdc_raw: "0",
        min_viable_size_usdc_raw: "0",
        thesis:
          "While wNEAR shows modest positive 24h momentum, conditions do not support a confident trade (balances / pricing robustness).",
        thesis_id: "hosted-live",
        model: "anthropic/claude-sonnet-4.6",
        timestamp: "2026-11-10T09:10:46.677Z",
        network: "sepolia",
      },
      llm: { model: "anthropic/claude-sonnet-4.6" },
    },
    fitter: {
      outcome: "REJECTED",
      reason_codes: ["FEASIBLE_SET_EMPTY"],
      constraints_checked: [{ name: "feasible_set", ok: false }],
      economic_viability: { ok: false },
      operation_id: "gate-j-94f0cfa0",
    },
    critic: {
      verdict: "ABSTAIN",
      reasons: [
        "No executable fitted trade exists (fitter REJECTED).",
        "Market/pricing inputs not sufficiently robust.",
        "USDC static parity assumption weakens sizing.",
      ],
      model: "openai/gpt-5.2",
      timestamp: "2026-11-10T09:10:46.677Z",
    },
    enforcement: {
      decision: "BLOCKED",
      may_sign: false,
      dry_run: true,
      reason_codes: ["CRITIC_ABSTAIN"],
      note: "LLM/Fitter outputs are not signing authorization",
      timestamp: "2026-11-10T09:10:46.677Z",
    },
    market: {
      as_of: "2026-11-10T09:10:00.000Z",
      venue: "coingecko+tidepool",
      freshness_s: 45,
    },
    note: "Recorded hosted OpenRouter evidence — not a new browser LLM call",
  };
  const rec = mapDecideToRecord(api, {
    mode: "recorded",
    mandateSource: "authoritative_onchain",
    portfolioId: "i-a-a4e7",
  });
  if (rec.proposal) rec.proposal.source = "live_llm";
  if (rec.critic) rec.critic.source = "live_llm";
  if (rec.fit) rec.fit.mode = "live_api";
  rec.note =
    "RECORDED hosted live (OCI) · Strategist NO_TRADE · Critic ABSTAIN · BLOCKED — not a new LLM call";
  return rec;
}

/** FIXTURE SCENARIOS — deterministic Fitter demos (no LLM claim). */
export async function runFixtureScenario(
  scenario: GateJScenarioId,
  portfolioId?: string
): Promise<GateJDecisionRecord> {
  const health = await gateJHealth();
  if (health.available) {
    const res = await getJson<GateJDecideApiResponse>("/gate-j/decide", {
      method: "POST",
      body: JSON.stringify({
        scenario: SCENARIO_API[scenario],
        dry_run: true,
        use_llm: false,
        portfolio_id: undefined,
      }),
    });
    if (!res.ok) {
      if (res.status === 401) {
        // Fall through to local deterministic Fitter (no privileged key in browser).
      }
    } else if (res.data.ok) {
      const mapped = mapDecideToRecord(res.data, {
        mode: "fixture",
        mandateSource: "demo_fixture",
        portfolioId,
      });
      // Prefer known fixture mandate amounts from local scenario labels when API omits them
      const local = GATE_J_SCENARIOS[scenario as ScenarioId];
      if (mapped.mandate) {
        mapped.mandate = {
          ...mapped.mandate,
          allowed_assets: local.allowed_assets,
          max_trade_value: local.max_trade_value,
          max_pending_exposure: local.max_pending_exposure,
          source: "demo_fixture",
        };
      }
      mapped.note = `${local.label} · fixture (not live LLM)`;
      return mapped;
    }
  }

  return buildLocalFixtureDecision(scenario, portfolioId);
}

/** @deprecated use runFixtureScenario */
export async function runGateJScenario(
  scenario: GateJScenarioId,
  portfolioId?: string
): Promise<GateJDecisionRecord> {
  return runFixtureScenario(scenario, portfolioId);
}

export async function fitViaApiOrLocal(input: {
  proposed_amount: string;
  min_viable_amount: string;
  proposed_asset: string;
  allowed_assets: string[];
  max_trade_value: string;
  max_pending_exposure?: string;
}): Promise<MandateFitResult> {
  return fitMandate(input);
}

function buildLocalFixtureDecision(
  scenarioId: GateJScenarioId,
  portfolioId?: string
): GateJDecisionRecord {
  const { scenario, fit } = runScenario(scenarioId as ScenarioId);
  const now = new Date().toISOString();
  const choice = fit.verdict === "REJECTED" ? "NO_TRADE" : "TRADE";
  const safety = buildSafetyStory({
    strategistChoice: "TRADE",
    strategistModel: "dry-run-scenario (not LLM)",
    criticVerdict: fit.verdict === "REJECTED" ? "REJECT" : "APPROVE",
    criticModel: "dry-run-critic-stub",
    fitterOutcome: fit.verdict,
    finalDecision: fit.verdict === "REJECTED" ? "NO_TRADE" : "EXECUTE_DRY_RUN",
    maySign: false,
  });

  return {
    decision_id: `fixture-${scenarioId}-${Date.now()}`,
    portfolio_id: portfolioId,
    stages: [
      {
        id: "market_research",
        label: "Market Research",
        status: "done",
        detail: "Fixture market premise (not live feeds).",
        at: now,
      },
      {
        id: "ai_strategy",
        label: "AI Strategy Proposal",
        status: "done",
        detail: "Labeled fixture input — not a live LLM call.",
        at: now,
      },
      {
        id: "mandate_fitting",
        label: "Mandate Fitting",
        status: "done",
        detail: `Deterministic Fitter → ${fit.verdict}`,
        at: fit.timestamp,
      },
      {
        id: "risk_review",
        label: "Independent Risk Review",
        status: "done",
        detail: "Fixture critic stub — not live GPT.",
        at: now,
      },
      {
        id: "policy_validation",
        label: "NEAR Policy Validation",
        status: "done",
        detail: "Fixture mirrors constraints; NEAR still final enforcer.",
        at: now,
      },
      {
        id: "execution",
        label: "Execution / Enforcement",
        status: "done",
        detail: `${choice} (fixture dry-run — no broadcast)`,
        at: now,
      },
      {
        id: "settlement",
        label: "Settlement Verification",
        status: "skipped",
        detail: "No on-chain settlement in fixture mode.",
        at: now,
      },
    ],
    proposal: {
      proposal_id: `scenario-${scenarioId}`,
      asset: scenario.proposed_asset,
      amount: scenario.proposed_amount,
      amount_display: scenario.amount_display,
      thesis: scenario.thesis,
      min_viable_amount: scenario.min_viable_amount,
      choice: "TRADE",
      model: "dry-run-scenario (not LLM)",
      timestamp: now,
      source: "dry_run_scenario",
      market_data: { venue: "fixture", as_of: now, freshness_s: 0 },
    },
    mandate: {
      mandate_epoch: 0,
      allowed_assets: scenario.allowed_assets,
      max_trade_value: scenario.max_trade_value,
      max_pending_exposure: scenario.max_pending_exposure,
      source: "demo_fixture",
      portfolio_id: portfolioId,
    },
    fit,
    critic: {
      verdict: fit.verdict === "REJECTED" ? "REJECT" : "APPROVE",
      rationale:
        fit.verdict === "REJECTED"
          ? `Fixture critic: refuse — ${fit.rejection_reasons.join(", ") || "constraints failed"}.`
          : `Fixture critic: approve fitted ${fit.verdict} size.`,
      model: "dry-run-critic-stub",
      timestamp: now,
      source: "dry_run_scenario",
    },
    policy: {
      mandate_epoch: 0,
      constraints: fit.constraints_satisfied,
      near_enforced: true,
      source: "dry_run_scenario",
    },
    enforcement: {
      decision: fit.verdict === "REJECTED" ? "NO_TRADE" : "EXECUTE_DRY_RUN",
      may_sign: false,
      dry_run: true,
      reason_codes: fit.rejection_reasons,
      note: "Fixture — not live LLM; not signing authorization",
      timestamp: now,
    },
    models: {
      researcher: null,
      strategist: "dry-run-scenario (not LLM)",
      critic: "dry-run-critic-stub",
    },
    safety_story: safety,
    execution: {
      choice,
      rationale:
        fit.verdict === "REJECTED"
          ? `NO_TRADE: ${fit.rejection_reasons.join("; ")}`
          : `Would ${fit.verdict === "ADAPTED" ? "adapt then " : ""}trade ${fit.final_amount} (fixture).`,
      dry_run: true,
      may_sign: false,
    },
    settlement: { status: "skipped_dry_run", verified: false },
    mode: "fixture",
    note: GATE_J_SCENARIOS[scenarioId as ScenarioId].label,
    summary: {
      fitter_outcome: fit.verdict,
      critic_verdict: fit.verdict === "REJECTED" ? "REJECT" : "APPROVE",
      final_decision: fit.verdict === "REJECTED" ? "NO_TRADE" : "EXECUTE_DRY_RUN",
      may_sign: false,
    },
  };
}
