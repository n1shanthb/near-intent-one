import { describe, expect, it } from "vitest";
import { fitMandate, runScenario, usdcDisplay } from "./mandateFitter";

describe("mandate fitter judge scenarios", () => {
  it("A ALLOWED — $20 inside $20 mandate", () => {
    const { fit } = runScenario("A_ALLOWED");
    expect(fit.verdict).toBe("ALLOWED");
    expect(fit.final_amount).toBe("20000000");
    expect(fit.parameters_changed).toHaveLength(0);
    expect(fit.economically_viable).toBe(true);
  });

  it("B ADAPTED — $100 fitted to $20", () => {
    const { fit } = runScenario("B_ADAPTED");
    expect(fit.verdict).toBe("ADAPTED");
    expect(fit.original_amount).toBe("100000000");
    expect(fit.final_amount).toBe("20000000");
    expect(fit.parameters_changed[0]?.field).toBe("amount");
    expect(usdcDisplay(fit.final_amount)).toMatch(/\$20/);
  });

  it("C REJECTED — adapted $20 below min viable $50", () => {
    const { fit } = runScenario("C_REJECTED");
    expect(fit.verdict).toBe("REJECTED");
    expect(fit.final_amount).toBeNull();
    expect(fit.rejection_reasons).toContain("ADAPTED_BELOW_MIN_VIABLE");
    expect(fit.economically_viable).toBe(false);
  });

  it("rejects allowlist miss", () => {
    const fit = fitMandate({
      proposed_amount: "1000000",
      min_viable_amount: "1",
      proposed_asset: "DOGE",
      allowed_assets: ["USDC"],
      max_trade_value: "100000000",
    });
    expect(fit.verdict).toBe("REJECTED");
    expect(fit.rejection_reasons).toContain("ASSET_NOT_ALLOWLISTED");
  });
});
