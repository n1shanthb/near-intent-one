import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { M2_BASE_ETH_USDC } from "./canaryRouteProfiles.mjs";
import { chooseAffordableUsdcAmount } from "./baseFunding.mjs";
import { runMission2BaseEthPreflight } from "./mission2BaseEth.mjs";
import {
  computeNetEdgeUsdc,
  evaluatePaperSignal,
  createPaperState,
  assertPaperFundedDisabled,
  engageKillSwitch,
} from "./paperTrading.mjs";

describe("Mission2 Base→Eth profile", () => {
  it("binds Base 8453 → Ethereum 1 USDC", () => {
    assert.equal(M2_BASE_ETH_USDC.source_chain_id, 8453);
    assert.equal(M2_BASE_ETH_USDC.destination_chain, "ethereum");
    assert.equal(M2_BASE_ETH_USDC.decimals_risk, "SAFE_SAME_DECIMALS");
  });
});

describe("chooseAffordableUsdcAmount", () => {
  it("reuses 997398 as below 1 USDC and picks 0.5 when available", () => {
    const low = chooseAffordableUsdcAmount({ balanceRaw: "997398" });
    assert.equal(low.ok, true);
    assert.equal(low.amount_raw, "500000");
    assert.equal(low.shortfall_for_1usdc, "2602");
  });
  it("fails when below all candidates", () => {
    const r = chooseAffordableUsdcAmount({ balanceRaw: "100000" });
    assert.equal(r.ok, false);
  });
});

describe("Mission2 preflight harness", () => {
  it("NO-GO when Base ETH missing even with USDC", async () => {
    const report = await runMission2BaseEthPreflight({
      deps: {
        tokens: {
          ok: true,
          tokens: [
            {
              assetId: M2_BASE_ETH_USDC.asset_in,
              contractAddress: M2_BASE_ETH_USDC.source_token,
              decimals: 6,
            },
            {
              assetId: M2_BASE_ETH_USDC.asset_out,
              contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
              decimals: 6,
            },
          ],
        },
        policyAdapters: {
          rpc: "https://example.invalid",
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
        },
        limits: {
          max_trade_value: "5000000",
          max_slippage_bps: 100,
          allowed_chains: ["near", "eip155:1", "eip155:42161", "eip155:8453"],
          allowed_assets: [M2_BASE_ETH_USDC.asset_in, M2_BASE_ETH_USDC.asset_out],
          allowed_destinations: [
            "nishanthb.near",
            "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4",
          ],
        },
        baseNative: { ok: true, wei: "0", ether: 0 },
        baseUsdc: { ok: true, raw: "997398", ui: 0.997398 },
        ethUsdcDest: { ok: true, raw: "0", ui: 0 },
        nonceLatest: { result: "0x0" },
        noncePending: { result: "0x0" },
        gasPrice: { ok: true, gas_price_wei: "5000000", gas_price_gwei: 0.005 },
        gasEstimate: { ok: true, estimated: false, gas_limit: "65000" },
        quote: {
          ok: true,
          dry: true,
          amount_in: "500000",
          amount_out: "497000",
          min_amount_out: "495000",
          quote: { refundFee: "300000", withdrawFee: "2000", timeEstimate: 40 },
        },
      },
    });
    assert.equal(report.mutations_invoked, false);
    assert.ok(report.blockers.some((b) => b.includes("mpc_base_native_eth_zero")));
    assert.equal(report.route.amount, "500000");
    assert.ok(report.warnings.some((w) => w.includes("reduced_canary")));
  });
});

describe("Paper trading", () => {
  it("keeps funded autonomous disabled", () => {
    const g = assertPaperFundedDisabled({
      NIO_MAINNET_ALLOW_BROADCAST: undefined,
    });
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
