import { describe, expect, it } from "vitest";
import {
  buildSafetyStory,
  loadHostedEvidenceRecord,
  mapDecideToRecord,
  runFixtureScenario,
} from "./gatej";
import type { GateJDecideApiResponse } from "../types/gateJ";

describe("gatej adapter", () => {
  it("safety story for hosted NO_TRADE + ABSTAIN + BLOCKED", () => {
    const story = buildSafetyStory({
      strategistChoice: "NO_TRADE",
      strategistModel: "anthropic/claude-sonnet-4.6",
      criticVerdict: "ABSTAIN",
      criticModel: "openai/gpt-5.2",
      fitterOutcome: "REJECTED",
      finalDecision: "BLOCKED",
      maySign: false,
    });
    expect(story.blocked_is_success).toBe(true);
    expect(story.headline).toContain("declined an inadequately supported trade");
    expect(story.headline).toContain("abstained");
    expect(story.headline).not.toContain("proposed a trade");
    expect(story.headline).not.toContain("independently rejected the proposal");
  });

  it("safety story for TRADE + Critic REJECT still accurate", () => {
    const story = buildSafetyStory({
      strategistChoice: "TRADE",
      strategistModel: "anthropic/claude-sonnet-4.6",
      criticVerdict: "REJECT",
      criticModel: "openai/gpt-5.2",
      fitterOutcome: "REJECTED",
      finalDecision: "BLOCKED",
      maySign: false,
    });
    expect(story.headline).toContain("Claude proposed a trade");
    expect(story.headline).toContain("GPT independently rejected");
  });

  it("maps hosted decide with on-chain mandate fields", () => {
    const api: GateJDecideApiResponse = {
      ok: true,
      dry_run: true,
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
          thesis: "Inadequate support",
          model: "anthropic/claude-sonnet-4.6",
          timestamp: "2026-11-10T09:10:46.677Z",
        },
      },
      fitter: {
        outcome: "REJECTED",
        reason_codes: ["FEASIBLE_SET_EMPTY"],
        constraints_checked: [{ name: "feasible_set", ok: false }],
      },
      critic: {
        verdict: "ABSTAIN",
        reasons: ["No executable fitted trade"],
        model: "openai/gpt-5.2",
      },
      enforcement: {
        decision: "BLOCKED",
        may_sign: false,
        dry_run: true,
        reason_codes: ["CRITIC_ABSTAIN"],
        note: "not signing auth",
      },
    };

    const rec = mapDecideToRecord(api, {
      mode: "live_ai",
      mandateSource: "authoritative_onchain",
      portfolioId: "i-a-a4e7",
    });

    expect(rec.proposal?.choice).toBe("NO_TRADE");
    expect(rec.critic?.verdict).toBe("ABSTAIN");
    expect(rec.enforcement?.decision).toBe("BLOCKED");
    expect(rec.mandate?.source).toBe("authoritative_onchain");
    expect(rec.mandate?.source_detail).toBe("on_chain:get_gate_j_mandate");
    expect(rec.mandate?.mandate_epoch).toBe(3);
    expect(rec.mandate?.policy_hash).toBe("gate-i-closure-v1");
    expect(rec.mandate?.portfolio_id).toBe("i-a-a4e7");
    expect(rec.safety_story?.headline).toContain("declined an inadequately supported");
  });

  it("recorded hosted evidence matches OCI trace shape", () => {
    const rec = loadHostedEvidenceRecord();
    expect(rec).not.toBeNull();
    expect(rec!.mode).toBe("recorded");
    expect(rec!.proposal?.choice).toBe("NO_TRADE");
    expect(rec!.critic?.verdict).toBe("ABSTAIN");
    expect(rec!.fit?.verdict).toBe("REJECTED");
    expect(rec!.enforcement?.decision).toBe("BLOCKED");
    expect(rec!.mandate?.source).toBe("authoritative_onchain");
  });

  it("local fixture scenarios return labeled demo_fixture (not live LLM)", async () => {
    const a = await runFixtureScenario("A_ALLOWED");
    expect(a.mode).toBe("fixture");
    expect(a.mandate?.source).toBe("demo_fixture");
    expect(a.proposal?.source).toBe("dry_run_scenario");
    expect(a.fit?.verdict).toBe("ALLOWED");

    const b = await runFixtureScenario("B_ADAPTED");
    expect(b.fit?.verdict).toBe("ADAPTED");

    const c = await runFixtureScenario("C_REJECTED");
    expect(c.fit?.verdict).toBe("REJECTED");
  });
});
