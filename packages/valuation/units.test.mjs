import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkTradeWithinUsdLimit,
  estimateUsd,
  formatRaw,
} from "./units.mjs";

describe("valuation units", () => {
  it("formats USDC raw without treating wNEAR the same", () => {
    assert.equal(formatRaw("1000000", 6), "1");
    assert.equal(formatRaw("1000000000000000000000000", 24), "1");
  });

  it("estimates USDC USD and fails closed on wNEAR without quote", () => {
    const usdc = estimateUsd({
      assetId:
        "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet",
      amountRaw: "2500000",
    });
    assert.equal(usdc.ok, true);
    assert.ok(Math.abs(usdc.usdEstimate - 2.5) < 1e-9);

    const wnear = estimateUsd({
      assetId: "nep141:wnear.tidepool-sandbox.testnet",
      amountRaw: "1000000000000000000000000",
    });
    assert.equal(wnear.ok, false);
    assert.match(wnear.reason, /missing_pricing/);
  });

  it("enforces USD limit on USDC trades", () => {
    const ok = checkTradeWithinUsdLimit({
      assetIn: "USDC",
      amountInRaw: "1000000",
      maxTradeValueRaw: "100000000",
    });
    assert.equal(ok.ok, true);

    const bad = checkTradeWithinUsdLimit({
      assetIn: "USDC",
      amountInRaw: "200000000",
      maxTradeValueRaw: "100000000",
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "exceeds_max_trade_value_usd");
  });
});
