import { describe, expect, it } from "vitest";
import { compilePolicyFromText } from "./compile";

const GOOD =
  "Allow trading on Ethereum and NEAR, only USDC, ETH and NEAR. Maximum $10 per trade, $50 per day, 1% slippage and stop at 5% drawdown.";

describe("compilePolicyFromText", () => {
  it("compiles the judge example into enforced on-chain fields", () => {
    const r = compilePolicyFromText(GOOD, { nowMs: 1_700_000_000_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.onChainPayload.max_trade_value).toBe("10000000");
    expect(r.onChainPayload.daily_turnover_limit).toBe("50000000");
    expect(r.onChainPayload.max_slippage_bps).toBe(100);
    expect(r.policy.max_drawdown_bps).toBe(500);
    expect(r.explanation.some((e) => e.includes("PLANNED"))).toBe(true);
  });

  it("rejects impossible per-trade > daily", () => {
    const r = compilePolicyFromText(
      "Allow trading on NEAR, only USDC and NEAR. Maximum $80 per trade, $50 per day, 1% slippage."
    );
    expect(r.ok).toBe(false);
  });

  it("rejects ambiguous missing slippage", () => {
    const r = compilePolicyFromText(
      "Allow trading on NEAR, only USDC. Maximum $10 per trade, $50 per day."
    );
    expect(r.ok).toBe(false);
  });
});
