import { describe, expect, it } from "vitest";
import { buildOnboardingJourney } from "./onboardingJourney";

describe("onboarding journey", () => {
  it("marks unauthenticated user steps as BLOCKED/PENDING honestly", () => {
    const steps = buildOnboardingJourney({
      walletConnected: false,
      ownerVerified: false,
    });
    expect(steps[0].status).toBe("PENDING");
    expect(steps.find((s) => s.id === "verify_ownership")?.status).toBe(
      "BLOCKED"
    );
    expect(steps.find((s) => s.id === "deposit")?.status).toBe("BLOCKED");
    expect(steps.find((s) => s.id === "deposit")?.detail).toContain(
      "Do not send funds"
    );
    expect(steps.find((s) => s.id === "trade")?.status).toMatch(
      /BLOCKED|UNSUPPORTED/
    );
  });

  it("keeps deposit/trade blocked after ownership verify without provision", () => {
    const steps = buildOnboardingJourney({
      walletConnected: true,
      ownerVerified: true,
      ownerAccountId: "alice.testnet",
      portfolioStatus: "awaiting_operator",
      network: "testnet",
    });
    const create = steps.find((s) => s.id === "create_portfolio");
    expect(create?.status).toBe("PENDING");
    expect(create?.operatorRequired).toBe(true);
    expect(steps.find((s) => s.id === "deposit")?.status).toBe("BLOCKED");
    expect(steps.find((s) => s.id === "enable_agent")?.status).toBe("BLOCKED");
  });

  it("does not invent READY deposit for mainnet without evidence", () => {
    const steps = buildOnboardingJourney({
      walletConnected: true,
      ownerVerified: true,
      ownerAccountId: "alice.near",
      portfolioStatus: "ready",
      portfolioId: "p-1",
      portfolioOwner: "alice.near",
      policyContract: "policy.alice.near",
      intentsSignerId: "0xmpc",
      network: "mainnet",
    });
    expect(steps.find((s) => s.id === "deposit")?.status).toBe("BLOCKED");
    expect(steps.find((s) => s.id === "trade")?.status).toBe("BLOCKED");
  });
});
