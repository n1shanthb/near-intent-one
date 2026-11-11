import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFourChainUniverse,
  resolveCanonicalAssets,
  mapProviderChain,
} from "./tokenCatalog.mjs";
import {
  capitalAvailable,
  scoreCandidate,
  criticReview,
  runFourChainQuoteMatrix,
  DEMO_ROUTES,
} from "./multichainRouter.mjs";
import { requiredSigningPrimitive } from "./intents.mjs";
import { createProductionNearIntentsAdapter } from "./intents.production.mjs";
import { prepareFundedCanaryApproval } from "./canaryPrep.mjs";

const SAMPLE_TOKENS = [
  {
    assetId: "nep141:wrap.near",
    decimals: 24,
    blockchain: "near",
    symbol: "wNEAR",
    price: 3.5,
    priceUpdatedAt: new Date().toISOString(),
    contractAddress: "wrap.near",
  },
  {
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    decimals: 6,
    blockchain: "arb",
    symbol: "USDC",
    price: 1,
    priceUpdatedAt: new Date().toISOString(),
    contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  },
  {
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals: 6,
    blockchain: "base",
    symbol: "USDC",
    price: 1,
    priceUpdatedAt: new Date().toISOString(),
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  {
    assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    decimals: 6,
    blockchain: "eth",
    symbol: "USDC",
    price: 1,
    priceUpdatedAt: new Date().toISOString(),
    contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  },
  {
    assetId: "nep141:eth-0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.omft.near",
    decimals: 18,
    blockchain: "eth",
    symbol: "WETH",
    price: 3000,
    priceUpdatedAt: new Date().toISOString(),
    contractAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  },
  {
    assetId: "nep141:sol-ignore",
    decimals: 9,
    blockchain: "sol",
    symbol: "SOL",
    contractAddress: "So111",
  },
];

describe("token catalog four-chain", () => {
  it("maps provider chains and filters solana out", () => {
    assert.equal(mapProviderChain("arb"), "arbitrum");
    assert.equal(mapProviderChain("eth"), "ethereum");
    assert.equal(mapProviderChain("sol"), null);
    const u = buildFourChainUniverse(SAMPLE_TOKENS);
    assert.equal(u.counts.four_chain, 5);
    assert.equal(u.counts.total_catalog, 6);
    assert.equal(resolveCanonicalAssets(u).complete, true);
  });
});

describe("capital + signing", () => {
  it("rejects unverified balances", () => {
    const r = capitalAvailable(
      { "nep141:x": { amount_raw: "1000000", verified: false } },
      "nep141:x",
      "1"
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "balance_not_verified_on_chain");
  });

  it("classifies EVM vs NEAR signing primitives", () => {
    assert.equal(
      requiredSigningPrimitive({ originNetwork: "arbitrum" }).primitive,
      "EVM_ERC20_TRANSFER_TO_DEPOSIT"
    );
    assert.equal(
      requiredSigningPrimitive({ originNetwork: "near" }).may_use,
      false
    );
  });
});

describe("scoring / critic", () => {
  it("does not select on raw amountOut alone when capital missing", () => {
    const quote = {
      ok: true,
      quote: {
        amountOut: "999",
        amountOutUsd: "0.99",
        amountInUsd: "1.0",
        minAmountOut: "980",
      },
    };
    const scored = scoreCandidate({
      quote,
      capital: { ok: false, reason: "no_balance_entry" },
      mandate: {},
      signing: { may_use: true },
      route: DEMO_ROUTES[0],
    });
    assert.equal(scored.ok, false);
    const critic = criticReview({
      score_result: scored,
      signing: { may_use: true },
      bound: { ok: true },
      route: DEMO_ROUTES[0],
    });
    assert.equal(critic.verdict, "REJECT");
  });
});

describe("production adapter surface", () => {
  it("exposes getTokens/getQuote/deposit/status methods and keeps funded prep gated", async () => {
    const a = createProductionNearIntentsAdapter();
    assert.equal(typeof a.getTokens, "function");
    assert.equal(typeof a.prepareLiveQuote, "function");
    assert.equal(typeof a.constructDeposit, "function");
    assert.equal(typeof a.refundRecovery, "function");
    const live = await a.prepareLiveQuote({});
    assert.equal(live.ok, false);
    assert.equal(live.reason, "funded_quote_gate_off");
  });
});

describe("matrix with mock quotes", () => {
  it("returns NO_TRADE without verified balances even if quotes succeed", async () => {
    const catalog = {
      ok: true,
      ...buildFourChainUniverse(SAMPLE_TOKENS),
    };
    const quoteFn = async (req) => ({
      ok: true,
      dry: true,
      request: req,
      quote: {
        amountIn: req.amount,
        amountInUsd: "1.0",
        amountOut: "990000",
        amountOutUsd: "0.99",
        minAmountOut: "980000",
        deadline: new Date(Date.now() + 600_000).toISOString(),
      },
      amount_out: "990000",
      deadline: new Date(Date.now() + 600_000).toISOString(),
      correlation_id: "mock",
    });

    const out = await runFourChainQuoteMatrix({
      catalog,
      quoteFn,
      amount: "1000000",
      recipient: "root.near",
      refundTo: "0x9751874dc251d705ed571a447f7a00de5b845cf4",
      balances: {},
      mandate: { paused: true },
    });
    assert.equal(out.ok, true);
    assert.equal(out.quoted_count, 4);
    assert.equal(out.proposal.choice, "NO_TRADE");
    assert.equal(out.funded_execution, "DISABLED");
  });

  it("can select a TRADE when capital verified and mandate active", async () => {
    const catalog = {
      ok: true,
      ...buildFourChainUniverse(SAMPLE_TOKENS),
    };
    const arb =
      "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
    const quoteFn = async (req) => {
      const stable = req.destinationAsset.includes("usdc") || req.destinationAsset.includes("833589");
      return {
        ok: true,
        dry: true,
        request: req,
        quote: {
          amountIn: req.amount,
          amountInUsd: "1.0",
          amountOut: stable ? "997000" : "250000000000000000",
          amountOutUsd: stable ? "0.997" : "0.95",
          minAmountOut: stable ? "990000" : "240000000000000000",
          deadline: new Date(Date.now() + 600_000).toISOString(),
        },
        amount_out: stable ? "997000" : "250000000000000000",
        deadline: new Date(Date.now() + 600_000).toISOString(),
        correlation_id: "mock2",
      };
    };
    const out = await runFourChainQuoteMatrix({
      catalog,
      quoteFn,
      amount: "1000000",
      recipient: "0x1111111111111111111111111111111111111111",
      refundTo: "0x9751874dc251d705ed571a447f7a00de5b845cf4",
      balances: {
        [arb]: { amount_raw: "5000000", verified: true, chain: "arbitrum" },
      },
      mandate: { paused: false, revoked: false, max_slippage_bps: 50 },
      allowedRecipients: ["0x1111111111111111111111111111111111111111"],
      allowedRefunds: ["0x9751874dc251d705ed571a447f7a00de5b845cf4"],
    });
    assert.equal(out.ok, true);
    assert.equal(out.proposal.choice, "TRADE");
    assert.ok(out.proposal.route_id);
    assert.equal(out.proposal.funded_execution, "DISABLED");
  });
});

describe("canary prep", () => {
  it("is NO-GO while paused / unsigned / unverified", () => {
    const prep = prepareFundedCanaryApproval({
      proposal: { choice: "NO_TRADE", funded_execution: "DISABLED" },
    });
    assert.equal(prep.verdict, "NO-GO");
    assert.ok(prep.blockers.length > 0);
  });
});
