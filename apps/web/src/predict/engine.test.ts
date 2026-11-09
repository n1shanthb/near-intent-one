import { describe, expect, it } from "vitest";
import { compilePolicyFromText } from "../policy/compile";
import { comparePolicies, runPredict } from "./engine";
import { packForHorizon } from "./scenarios";

const A =
  "Allow trading on Ethereum and NEAR, only USDC and NEAR. Maximum $10 per trade, $50 per day, 1% slippage.";
const B =
  "Allow trading on Ethereum and NEAR, only USDC and NEAR. Maximum $5 per trade, $20 per day, 0.5% slippage.";

describe("predict engine", () => {
  it("is deterministic across runs", () => {
    const ca = compilePolicyFromText(A);
    expect(ca.ok).toBe(true);
    if (!ca.ok) return;
    const x = runPredict(ca.policy, "30d");
    const y = runPredict(ca.policy, "30d");
    expect(x).toEqual(y);
    expect(x.kind).toBe("illustrative");
    expect(x.provenance.toLowerCase()).toContain("not live");
  });

  it("tighter policy rejects more trades", () => {
    const ca = compilePolicyFromText(A);
    const cb = compilePolicyFromText(B);
    expect(ca.ok && cb.ok).toBe(true);
    if (!ca.ok || !cb.ok) return;
    const { a, b } = comparePolicies({
      policyA: ca.policy,
      policyB: cb.policy,
      horizon: "30d",
      pack: packForHorizon("30d"),
    });
    expect(b.rejectedCount).toBeGreaterThanOrEqual(a.rejectedCount);
  });
});
