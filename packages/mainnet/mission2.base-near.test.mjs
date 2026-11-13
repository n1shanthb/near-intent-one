import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  M2_BASE_NEAR_USDC,
  M2_BASE_ETH_USDC,
  resolveCanaryRouteProfile,
  assertRouteAssetIsolation,
} from "./canaryRouteProfiles.mjs";
import { chooseAffordableUsdcAmount } from "./baseFunding.mjs";
import {
  findPolicyCompliantAmount,
  runMission2BaseNearPreflight,
} from "./mission2BaseNear.mjs";
import { CANARY_CHAIN_ID } from "./canaryOneShot.mjs";

describe("Mission2 Base→NEAR profile", () => {
  it("binds Base 8453 → NEAR NEP-141 USDC", () => {
    assert.equal(M2_BASE_NEAR_USDC.source_chain_id, 8453);
    assert.equal(M2_BASE_NEAR_USDC.destination_chain, "near");
    assert.equal(M2_BASE_NEAR_USDC.destination_kind, "nep141");
    assert.equal(M2_BASE_NEAR_USDC.decimals_risk, "SAFE_SAME_DECIMALS");
    assert.equal(resolveCanaryRouteProfile("m2").id, M2_BASE_NEAR_USDC.id);
    assert.equal(M2_BASE_ETH_USDC.status, "DEFERRED");
  });

  it("rejects J8B Arb source and Eth dest confusion", () => {
    assert.equal(CANARY_CHAIN_ID, 42161);
    assert.throws(() =>
      assertRouteAssetIsolation(M2_BASE_NEAR_USDC, { chainId: 42161 })
    );
    assert.throws(() =>
      assertRouteAssetIsolation(M2_BASE_NEAR_USDC, {
        assetOut: "nep141:wrap.near",
      })
    );
  });
});

describe("chooseAffordableUsdcAmount exact balance", () => {
  it("prefers exact 997398 leftover under 1 USDC", () => {
    const r = chooseAffordableUsdcAmount({ balanceRaw: "997398" });
    assert.equal(r.ok, true);
    assert.equal(r.amount_raw, "997398");
    assert.equal(r.used_exact_balance, true);
  });
});

describe("findPolicyCompliantAmount", () => {
  it("selects first amount whose quote clears policy floor", async () => {
    const calls = [];
    const quoteFn = async ({ amount }) => {
      calls.push(amount);
      const ain = BigInt(amount);
      // Simulate Base→NEAR: small withdraw fee so 997398 passes, tiny amounts fail
      const out = ain - 5_000n;
      const min = (out * 9950n) / 10000n;
      return {
        ok: true,
        amount_out: out.toString(),
        min_amount_out: min.toString(),
        quote: { refundFee: "0", withdrawFee: "5000", amountOut: out.toString(), minAmountOut: min.toString() },
      };
    };
    const r = await findPolicyCompliantAmount({
      balanceRaw: "997398",
      requestedMaxRaw: 1_000_000n,
      route: M2_BASE_NEAR_USDC,
      quoteFn,
      slipBps: 50,
      policyMaxSlipBps: 100,
    });
    assert.equal(r.ok, true);
    assert.equal(r.amount_raw, "997398");
    assert.equal(r.policy.result, "PASS");
    assert.ok(calls.length >= 1);
  });

  it("NO-GO when all amounts fail policy", async () => {
    const quoteFn = async ({ amount }) => ({
      ok: true,
      amount_out: "1000",
      min_amount_out: "1000",
      quote: { withdrawFee: "300000" },
    });
    const r = await findPolicyCompliantAmount({
      balanceRaw: "997398",
      route: M2_BASE_NEAR_USDC,
      quoteFn,
      slipBps: 50,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_policy_compliant_amount_within_balance");
  });
});

describe("Mission2 Base→NEAR preflight harness", () => {
  it("PASS path when funded gas + storage + policy quote", async () => {
    const report = await runMission2BaseNearPreflight({
      deps: {
        tokens: {
          ok: true,
          tokens: [
            {
              assetId: M2_BASE_NEAR_USDC.asset_in,
              contractAddress: M2_BASE_NEAR_USDC.source_token,
              decimals: 6,
            },
            {
              assetId: M2_BASE_NEAR_USDC.asset_out,
              contractAddress:
                "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
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
          allowed_assets: [
            M2_BASE_NEAR_USDC.asset_in,
            M2_BASE_NEAR_USDC.asset_out,
          ],
          allowed_destinations: [
            "nishanthb.near",
            "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4",
          ],
        },
        baseNative: { ok: true, wei: "100000000000000", ether: 0.0001 },
        baseUsdc: { ok: true, raw: "997398", ui: 0.997398 },
        nonceLatest: { result: "0x0" },
        noncePending: { result: "0x0" },
        gasPrice: { ok: true, gas_price_wei: "5000000", gas_price_gwei: 0.005 },
        gasEstimate: { ok: true, estimated: false, gas_limit: "65000" },
        storage: { ok: true, registered: true },
        amountSearch: {
          ok: true,
          amount_raw: "997398",
          amount_usdc: 0.997398,
          quote: {
            ok: true,
            dry: true,
            amount_out: "990000",
            min_amount_out: "990000",
            quote: { refundFee: "0", withdrawFee: "4403", timeEstimate: 40 },
          },
          policy: {
            result: "PASS",
            policy_floor: "987424",
            min_amount_out: "990000",
          },
        },
      },
    });
    assert.equal(report.verdict, "READY_FOR_OWNER_APPROVAL");
    assert.equal(report.mutations_invoked, false);
    assert.equal(report.route.amount, "997398");
    assert.equal(report.near_destination.register_once, true);
  });

  it("NO-GO when Base ETH missing", async () => {
    const report = await runMission2BaseNearPreflight({
      deps: {
        tokens: {
          ok: true,
          tokens: [
            {
              assetId: M2_BASE_NEAR_USDC.asset_in,
              contractAddress: M2_BASE_NEAR_USDC.source_token,
            },
            {
              assetId: M2_BASE_NEAR_USDC.asset_out,
              contractAddress:
                "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
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
          allowed_assets: [
            M2_BASE_NEAR_USDC.asset_in,
            M2_BASE_NEAR_USDC.asset_out,
          ],
          allowed_destinations: [
            "nishanthb.near",
            "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4",
          ],
        },
        baseNative: { ok: true, wei: "0", ether: 0 },
        baseUsdc: { ok: true, raw: "997398", ui: 0.997398 },
        nonceLatest: { result: "0x0" },
        noncePending: { result: "0x0" },
        gasPrice: { ok: true, gas_price_wei: "5000000" },
        gasEstimate: { ok: true, gas_limit: "65000" },
        storage: { ok: true, registered: true },
        amountSearch: {
          ok: true,
          amount_raw: "997398",
          amount_usdc: 0.997398,
          quote: {
            ok: true,
            min_amount_out: "990000",
            amount_out: "990000",
            quote: {},
          },
          policy: { result: "PASS", policy_floor: "987424" },
        },
      },
    });
    assert.equal(report.verdict, "NO-GO");
    assert.ok(report.blockers.some((b) => b.includes("mpc_base_native_eth_zero")));
  });
});
