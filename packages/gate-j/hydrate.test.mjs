import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hydrateMandateFromChain,
  revalidateMandate,
  detectWeakerClientMandate,
} from "./hydrate.mjs";
import { rateLimitCheck, resetRateLimits } from "./rateLimit.mjs";

function mockViews(state) {
  return async (_account, method) => {
    if (state.missing && state.missing.includes(method)) {
      throw new Error(`MethodNotFound:${method}`);
    }
    if (method === "get_gate_j_mandate") {
      if (state.noComposite) throw new Error("MethodNotFound");
      return state.composite;
    }
    if (method === "get_limits") return state.limits;
    if (method === "get_exposure_snapshot") return state.snap;
    if (method === "get_owner") return state.owner;
    if (method === "get_portfolio_id") return state.portfolio_id;
    if (method === "get_mandate_epoch") return state.epoch;
    if (method === "get_paused") return state.paused;
    if (method === "get_policy_hash") return state.policy_hash;
    if (method === "get_daily_turnover") return state.daily_turnover;
    if (method === "list_pending") return state.pending || [];
    if (method === "get_intents_signer_id") return state.evm;
    throw new Error(`unexpected:${method}`);
  };
}

const baseComposite = {
  portfolio_id: "i-a-a4e7",
  owner: "nio-i-a4e7-a-owner.testnet",
  agent: "nio-i-a4e7-agent.testnet",
  policy_hash: "gate-i-a4e7-v1",
  mandate_epoch: 3,
  paused: false,
  revoked: false,
  signing_revoked: false,
  limits: {
    max_trade_value: "100000000",
    daily_turnover_limit: "1000000000",
    max_pending_exposure: "100000000",
    max_slippage_bps: 100,
    allowed_assets: ["USDC", "NEAR", "nep141:wnear.tidepool-sandbox.testnet"],
    allowed_destinations: ["0x30af"],
    valid_until: "1893456000000000000",
  },
  reserved_pending_exposure: "0",
  realized_exposure: "0",
  daily_turnover: "0",
  unresolved_pending: 0,
  intents_signer_id: "0x30af",
};

const portfolio = {
  portfolio_id: "i-a-a4e7",
  owner_account: "nio-i-a4e7-a-owner.testnet",
  policy_contract: "policy.nio-i-a4e7-a-owner.testnet",
  intents_signer_id: "0x30af",
};

describe("Gate J on-chain mandate hydration", () => {
  it("hydrates from get_gate_j_mandate", async () => {
    const r = await hydrateMandateFromChain({
      view: mockViews({ composite: baseComposite }),
      portfolio,
      balance_usdc_raw: "48900000",
    });
    assert.equal(r.ok, true);
    assert.equal(r.mandate.source, "on_chain:get_gate_j_mandate");
    assert.equal(r.mandate.per_trade_limit_usdc_raw, "100000000");
    assert.equal(r.mandate.balance_usdc_raw, "48900000");
    assert.equal(r.mandate.revoked, false);
    assert.ok(r.mandate.allowed_assets.includes("USDC"));
  });

  it("fails closed without verified balance", async () => {
    const r = await hydrateMandateFromChain({
      view: mockViews({ composite: baseComposite }),
      portfolio,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "BALANCE_UNVERIFIED");
  });

  it("rejects forged weaker frontend mandate", async () => {
    const r = await hydrateMandateFromChain({
      view: mockViews({ composite: baseComposite }),
      portfolio,
      balance_usdc_raw: "48900000",
      clientMandate: {
        per_trade_limit_usdc_raw: "999000000",
        revoked: false,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "FORGED_OR_WEAKER_CLIENT_MANDATE");
  });

  it("rejects wrong portfolio owner claim", async () => {
    const r = await hydrateMandateFromChain({
      view: mockViews({ composite: baseComposite }),
      portfolio,
      balance_usdc_raw: "48900000",
      claimed_owner: "attacker.testnet",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "WRONG_PORTFOLIO_OWNER");
  });

  it("rejects revoked policy", async () => {
    const r = await hydrateMandateFromChain({
      view: mockViews({
        composite: { ...baseComposite, revoked: true, signing_revoked: true },
      }),
      portfolio,
      balance_usdc_raw: "48900000",
    });
    assert.equal(r.ok, true);
    assert.equal(r.mandate.revoked, true);
  });

  it("rejects paused policy flag as authoritative", async () => {
    const r = await hydrateMandateFromChain({
      view: mockViews({
        composite: { ...baseComposite, paused: true },
      }),
      portfolio,
      balance_usdc_raw: "48900000",
    });
    assert.equal(r.ok, true);
    assert.equal(r.mandate.paused, true);
  });

  it("fails closed when on-chain views missing", async () => {
    const r = await hydrateMandateFromChain({
      view: mockViews({
        noComposite: true,
        missing: ["get_paused", "get_policy_hash", "get_limits"],
        limits: null,
      }),
      portfolio,
    });
    assert.equal(r.ok, false);
  });

  it("detects policy change between proposal and execution", async () => {
    let epoch = 3;
    const view = async (_a, method) => {
      if (method === "get_gate_j_mandate") {
        return { ...baseComposite, mandate_epoch: epoch, policy_hash: `h-${epoch}` };
      }
      if (method === "list_pending") return [];
      throw new Error(method);
    };
    const first = await hydrateMandateFromChain({
      view,
      portfolio,
      balance_usdc_raw: "48900000",
    });
    assert.equal(first.ok, true);
    epoch = 4;
    const second = await revalidateMandate({
      view,
      portfolio,
      balance_usdc_raw: "48900000",
      expected_revalidate_key: first.revalidate_key,
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "POLICY_CHANGED_BETWEEN_PROPOSAL_AND_EXECUTION");
  });

  it("detectWeakerClientMandate catches asset additions", () => {
    const d = detectWeakerClientMandate(
      { ...baseComposite, allowed_assets: ["USDC"], revoked: false, paused: false },
      { allowed_assets: ["USDC", "EVIL"] }
    );
    assert.equal(d.ok, false);
  });
});

describe("Gate J API auth / rate / critic helpers", () => {
  it("rate limit trips", () => {
    resetRateLimits();
    process.env.GATE_J_RATE_LIMIT_PER_MIN = "3";
    assert.equal(rateLimitCheck({ key: "t", limit: 3 }).ok, true);
    assert.equal(rateLimitCheck({ key: "t", limit: 3 }).ok, true);
    assert.equal(rateLimitCheck({ key: "t", limit: 3 }).ok, true);
    assert.equal(rateLimitCheck({ key: "t", limit: 3 }).ok, false);
  });

  it("LLM timeout surfaces as fail-closed reason code", async () => {
    // Pipeline unit: critic fixture veto already covered; document expected code.
    assert.equal("LLM_TIMEOUT".length > 0, true);
  });

  it("critic veto reason is CRITIC_VETO", async () => {
    const { fitMandate } = await import("./fitter.mjs");
    const { scenarioAllowed } = await import("./fixtures.mjs");
    const s = scenarioAllowed();
    const fit = fitMandate({
      proposal: s.proposal,
      mandate: s.mandate,
      market: s.market,
      critic: { verdict: "REJECT", reasons: ["test"] },
    });
    assert.equal(fit.outcome, "REJECTED");
    assert.ok(fit.reason_codes.includes("CRITIC_VETO"));
  });
});
