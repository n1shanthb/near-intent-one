import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { M2_BASE_ETH_USDC } from "./canaryRouteProfiles.mjs";
import { chooseAffordableUsdcAmount } from "./baseFunding.mjs";
import {
  computeNetEdgeUsdc,
  evaluatePaperSignal,
  createPaperState,
  assertPaperFundedDisabled,
  engageKillSwitch,
} from "./paperTrading.mjs";

describe("Deferred Base→Eth profile", () => {
  it("remains marked DEFERRED", () => {
    assert.equal(M2_BASE_ETH_USDC.status, "DEFERRED");
    assert.equal(M2_BASE_ETH_USDC.destination_chain, "ethereum");
  });
});

describe("chooseAffordableUsdcAmount basics", () => {
  it("fails when below all candidates", () => {
    const r = chooseAffordableUsdcAmount({
      balanceRaw: "100000",
      includeExactBalance: false,
      candidates: [1_000_000n, 500_000n, 250_000n],
    });
    assert.equal(r.ok, false);
  });
});

describe("Paper trading", () => {
  it("keeps funded autonomous disabled", () => {
    const g = assertPaperFundedDisabled({});
    assert.equal(g.ok, true);
    assert.equal(g.gates.autonomous_execution_enabled, false);
  });

  it("skips when edge below minimum or kill switch", () => {
    const state = createPaperState({ min_net_edge_bps: 20 });
    const edge = computeNetEdgeUsdc({
      amountInUsdc: 1,
      amountOutUsdc: 0.995,
      gasUsd: 0.01,
      withdrawFeeUsdc: 0.004,
    });
    const cand = {
      amount_usdc: 1,
      edge_bps: edge.edge_bps,
      net_usdc: edge.net_usdc,
      policy_fit: "PASS",
      route_allowlisted: true,
    };
    const d = evaluatePaperSignal(cand, state);
    assert.equal(d.ok, false);
    assert.ok(d.reasons.includes("edge_below_min"));
    engageKillSwitch(state, "test");
    const d2 = evaluatePaperSignal(
      { ...cand, edge_bps: 100, net_usdc: 0.01 },
      state
    );
    assert.ok(d2.reasons.includes("kill_switch"));
  });

  it("takes paper trade when limits pass", () => {
    const state = createPaperState({ min_net_edge_bps: -100 });
    const d = evaluatePaperSignal(
      {
        amount_usdc: 1,
        edge_bps: 10,
        net_usdc: 0.001,
        policy_fit: "PASS",
        route_allowlisted: true,
      },
      state
    );
    assert.equal(d.action, "PAPER_TAKE");
  });
});
