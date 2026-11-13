import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyQuoteAgainstPolicy,
  scorePassCandidate,
  amountRawUsdc,
  MAX_TRADE_VALUE_RAW,
  diagnoseScanFailure,
  SCAN_ROUTES,
} from "./j5_2.quoteScan.mjs";
import { MPC_EVM } from "./quotePath.mjs";

function fakeOkQuote({
  slip = 50,
  amount = "1000000",
  minOut = "995000",
  amountOut = "997000",
  origin,
  dest,
}) {
  const quoteRequest = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: slip,
    originAsset: origin,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: dest,
    amount,
    refundTo: MPC_EVM,
    refundType: "ORIGIN_CHAIN",
    recipient: MPC_EVM,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 600_000).toISOString(),
  };
  const quote = {
    amountIn: amount,
    amountInFormatted: "1",
    amountInUsd: "1",
    minAmountIn: amount,
    amountOut,
    amountOutFormatted: "0.997",
    amountOutUsd: "0.997",
    minAmountOut: minOut,
  };
  return {
    ok: true,
    dry: true,
    quote,
    amount_in: amount,
    amount_out: amountOut,
    min_amount_out: minOut,
    timestamp: new Date().toISOString(),
    correlation_id: "test",
    one_click_response: {
      quoteRequest,
      quote,
      signature: "ed25519:test",
      timestamp: new Date().toISOString(),
      correlationId: "test",
    },
    one_click_verify: {
      ok: true,
      verified: true,
      quote_hash: "abc",
    },
  };
}

describe("J5.2 quote classification", () => {
  it("PASS when minOut >= 100bps floor and verify ok", () => {
    const route = SCAN_ROUTES[0];
    const origin =
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
    const dest =
      "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
    const r = classifyQuoteAgainstPolicy({
      quoteResult: fakeOkQuote({
        slip: 50,
        minOut: "990000",
        origin,
        dest,
      }),
      route,
      slippageTolerance: 50,
      amountUsdc: 1,
    });
    assert.equal(r.status, "PASS", JSON.stringify(r.reasons));
    assert.equal(r.values_altered, false);
    assert.equal(r.policy_floor, "990000");
  });

  it("BLOCKED when minOut 984553 below floor 990000 (no inflation)", () => {
    const route = SCAN_ROUTES.find((x) => x.id === "eth_usdc_to_arb_usdc");
    const r = classifyQuoteAgainstPolicy({
      quoteResult: fakeOkQuote({
        slip: 100,
        minOut: "984553",
        amountOut: "994498",
        origin:
          "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
        dest: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
      }),
      route,
      slippageTolerance: 100,
      amountUsdc: 1,
    });
    assert.equal(r.status, "BLOCKED");
    assert.ok(
      r.reasons.some((x) => x.startsWith("min_out_below_policy_floor"))
    );
    assert.ok(
      r.reasons.includes("hypothesis_slip_tolerance_consumes_full_policy_budget")
    );
  });

  it("rejects amounts above max_trade_value", () => {
    assert.equal(amountRawUsdc(5), MAX_TRADE_VALUE_RAW);
    const r = classifyQuoteAgainstPolicy({
      quoteResult: { ok: true },
      route: SCAN_ROUTES[0],
      slippageTolerance: 50,
      amountUsdc: 6,
    });
    assert.equal(r.status, "BLOCKED");
    assert.deepEqual(r.reasons, ["exceeds_max_trade_value"]);
  });

  it("scores prefer low-gas Base/Arbitrum over Ethereum", () => {
    const base = {
      status: "PASS",
      retention_usd: 0.995,
      prefer_low_gas: true,
      source_chain: "base",
      slippage_tolerance_bps: 50,
      amount_usdc: 1,
    };
    const eth = {
      status: "PASS",
      retention_usd: 0.995,
      prefer_low_gas: false,
      source_chain: "ethereum",
      slippage_tolerance_bps: 50,
      amount_usdc: 1,
    };
    assert.ok(scorePassCandidate(base) > scorePassCandidate(eth));
  });

  it("diagnoseScanFailure summarizes floor blocks", () => {
    const d = diagnoseScanFailure({
      rows: [
        { reasons: ["min_out_below_policy_floor:x"] },
        { reasons: ["min_out_below_policy_floor:y"] },
        { reasons: ["signature_verify:fail"] },
      ],
    });
    assert.equal(d.reason_histogram[0][0], "min_out_below_policy_floor");
    assert.match(d.assessment, /structural/);
  });
});
