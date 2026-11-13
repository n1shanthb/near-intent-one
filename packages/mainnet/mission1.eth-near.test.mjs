import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  M1_ETH_NEAR_USDC,
  M2_BASE_ETH_USDC,
  assertNotJ8bRoute,
  assertRouteAssetIsolation,
  resolveCanaryRouteProfile,
  NEAR_NATIVE_USDC_ASSET,
} from "./canaryRouteProfiles.mjs";
import { evaluateEthereumGasEconomics } from "./ethereumFunding.mjs";
import { verifyNearNep141Delta, verifyEvmUsdcDelta } from "./canarySettlement.mjs";
import { runMission1EthNearPreflight } from "./mission1EthNear.mjs";
import { CANARY_CHAIN_ID, CANARY_ASSET_OUT } from "./canaryOneShot.mjs";

describe("Mission1 route profiles", () => {
  it("binds ethereum chain 1 and NEAR NEP-141 USDC, not wrap.near", () => {
    assert.equal(M1_ETH_NEAR_USDC.source_chain_id, 1);
    assert.equal(M1_ETH_NEAR_USDC.asset_out, NEAR_NATIVE_USDC_ASSET);
    assert.equal(M1_ETH_NEAR_USDC.decimals_risk, "SAFE_SAME_DECIMALS");
    assert.ok(M1_ETH_NEAR_USDC.not_assets.includes("nep141:wrap.near"));
  });

  it("rejects J8B Arb/Base confusion", () => {
    assert.equal(CANARY_CHAIN_ID, 42161);
    assert.throws(() =>
      assertRouteAssetIsolation(M1_ETH_NEAR_USDC, {
        chainId: 42161,
      })
    );
    assert.throws(() =>
      assertRouteAssetIsolation(M1_ETH_NEAR_USDC, {
        assetOut: CANARY_ASSET_OUT,
      })
    );
    assert.throws(() =>
      assertNotJ8bRoute({
        source_chain_id: 42161,
        asset_out: "x",
      })
    );
  });

  it("rejects wrong token / decimals destination swap to wrap.near", () => {
    assert.throws(() =>
      assertRouteAssetIsolation(M1_ETH_NEAR_USDC, {
        assetOut: "nep141:wrap.near",
      })
    );
  });

  it("resolves m1/m2 ids", () => {
    assert.equal(resolveCanaryRouteProfile("m1").id, M1_ETH_NEAR_USDC.id);
    assert.equal(resolveCanaryRouteProfile("m2").id, M2_BASE_ETH_USDC.id);
    assert.equal(M2_BASE_ETH_USDC.source_chain_id, 8453);
    assert.equal(M2_BASE_ETH_USDC.destination_chain, "ethereum");
  });
});

describe("Ethereum gas economics", () => {
  it("flags disproportionate fee vs 1 USDC", () => {
    const r = evaluateEthereumGasEconomics({
      gasPriceWei: 50_000_000_000n, // 50 gwei
      gasLimit: 250_000n,
      tradeAmountRaw: 1_000_000n,
      ethUsdHint: 3000,
    });
    assert.equal(r.verdict, "GAS_DISPROPORTIONATE_TO_TRADE");
  });

  it("accepts low current-mainnet-like fees", () => {
    const r = evaluateEthereumGasEconomics({
      gasPriceWei: 500_000_000n, // 0.5 gwei
      gasLimit: 65_000n,
      tradeAmountRaw: 1_000_000n,
      ethUsdHint: 3200,
    });
    assert.equal(r.verdict, "OK");
  });
});

describe("Settlement verifiers", () => {
  it("verifyNearNep141Delta requires rpc and checks min out", async () => {
    const missing = await verifyNearNep141Delta({
      accountId: "nishanthb.near",
      beforeRaw: "0",
      minAmountOut: "1",
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "near_rpc_required");

    let calls = 0;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        json: async () => ({
          result: {
            result: Array.from(Buffer.from(JSON.stringify("1500000"))),
          },
        }),
      };
    };
    try {
      const ok = await verifyNearNep141Delta({
        accountId: "nishanthb.near",
        beforeRaw: "500000",
        minAmountOut: "900000",
        rpcUrl: "https://example.invalid",
      });
      assert.equal(ok.ok, true);
      assert.equal(ok.delta, "1000000");
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it("verifyEvmUsdcDelta generalizes Base holder check", async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      json: async () => ({
        result:
          "0x00000000000000000000000000000000000000000000000000000000000f4240",
      }),
    });
    try {
      const r = await verifyEvmUsdcDelta({
        holder: "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4",
        beforeRaw: "0",
        minAmountOut: "994904",
        rpcUrl: "https://example.invalid",
        token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      });
      assert.equal(r.ok, true);
      assert.equal(r.after_raw, "1000000");
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});

describe("Mission1 preflight (harness)", () => {
  it("returns NO-GO when unfunded and storage missing without live calls", async () => {
    const report = await runMission1EthNearPreflight({
      deps: {
        tokens: {
          ok: true,
          tokens: [
            {
              assetId: M1_ETH_NEAR_USDC.asset_in,
              decimals: 6,
              contractAddress: M1_ETH_NEAR_USDC.source_token,
            },
            {
              assetId: M1_ETH_NEAR_USDC.asset_out,
              decimals: 6,
              contractAddress:
                "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
            },
            { assetId: "nep141:wrap.near", decimals: 24, contractAddress: "wrap.near" },
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
          max_gas_budget: "2500000000000000",
          allowed_chains: ["near", "eip155:1", "eip155:42161", "eip155:8453"],
          allowed_assets: [M1_ETH_NEAR_USDC.asset_in, M1_ETH_NEAR_USDC.asset_out],
          allowed_destinations: [
            "nishanthb.near",
            "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4",
          ],
        },
        nativeBalance: { ok: true, wei: "0", ether: 0 },
        usdcBalance: { ok: true, raw: "0", ui: 0 },
        nonceLatest: { result: "0x0" },
        noncePending: { result: "0x0" },
        gasPrice: { ok: true, gas_price_wei: "500000000", gas_price_gwei: 0.5 },
        gasEstimate: { ok: true, estimated: false, gas_limit: "65000" },
        storage: {
          ok: false,
          registered: false,
          note: "Owner must storage_deposit",
        },
        quote: {
          ok: true,
          dry: true,
          amount_in: "1000000",
          amount_out: "995395",
          min_amount_out: "990418",
          quote: { refundFee: "300000", withdrawFee: "4403", timeEstimate: 45 },
        },
      },
    });
    assert.equal(report.verdict, "NO-GO");
    assert.equal(report.mutations_invoked, false);
    assert.ok(report.blockers.some((b) => b.includes("mpc_eth_usdc_insufficient")));
    assert.ok(report.blockers.some((b) => b.includes("mpc_ethereum_native_eth_zero")));
    assert.ok(report.blockers.some((b) => b.includes("near_usdc_storage_unregistered")));
    assert.equal(report.quote.policy_fit.result, "PASS");
  });
});
