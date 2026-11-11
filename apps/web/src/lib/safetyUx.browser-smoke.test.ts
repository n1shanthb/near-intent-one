/**
 * Browser-facing safety smoke expectations (no funded txs).
 * Complements Playwright/manual MCP checks against the deployed SPA.
 */
import { describe, expect, it } from "vitest";
import { evaluateDepositReadiness } from "./depositReadiness";
import { buildOnboardingJourney } from "./onboardingJourney";
import { isDemoPortfolioId } from "./publicDemo";
import { mainnetTradingControlsEnabled } from "./network";

describe("browser E2E safety scenarios (logic)", () => {
  it("new unauthenticated user: journey blocked, deposits blocked", () => {
    const journey = buildOnboardingJourney({
      walletConnected: false,
      ownerVerified: false,
    });
    expect(journey.every((s) => s.status !== "READY" || s.id === "connect_wallet")).toBe(
      true
    );
    const deposit = evaluateDepositReadiness({
      chain: "mainnet",
      ownerVerified: false,
    });
    expect(deposit.message).toMatch(/Do not send funds/);
  });

  it("invalid / missing owner session blocks agent mutations path", () => {
    const journey = buildOnboardingJourney({
      walletConnected: true,
      ownerVerified: false,
    });
    expect(journey.find((s) => s.id === "enable_agent")?.status).toBe("BLOCKED");
  });

  it("different owner / demo portfolio never treated as personal custody", () => {
    expect(isDemoPortfolioId("i-a-a4e7")).toBe(true);
    const deposit = evaluateDepositReadiness({
      chain: "sepolia",
      ownerVerified: true,
      ownerAccountId: "alice.testnet",
      portfolioId: "i-a-a4e7",
      portfolioOwner: "bob.testnet",
    });
    expect(deposit.allowed).toBe(false);
  });

  it("mainnet deposit + trading remain blocked", () => {
    expect(mainnetTradingControlsEnabled()).toBe(false);
    const d = evaluateDepositReadiness({
      chain: "ethereum",
      ownerVerified: true,
      ownerAccountId: "alice.near",
      portfolioId: "p1",
      portfolioOwner: "alice.near",
      policyContract: "policy.alice.near",
      intentsSignerId: "0x1",
      backendReady: true,
      portfolioStatus: "ready",
    });
    expect(d.allowed).toBe(false);
  });

  it("wallet disconnect / session expiry → ownerVerified false path", () => {
    const afterLogout = buildOnboardingJourney({
      walletConnected: false,
      ownerVerified: false,
    });
    expect(afterLogout.find((s) => s.id === "verify_ownership")?.status).toBe(
      "BLOCKED"
    );
    expect(afterLogout.find((s) => s.id === "deposit")?.status).toBe("BLOCKED");
  });

  it("testnet demo portfolio id remains identifiable and separate", () => {
    expect(isDemoPortfolioId("i-a-a4e7")).toBe(true);
    expect(isDemoPortfolioId("nio-c-abc")).toBe(true);
    expect(isDemoPortfolioId("personal-xyz")).toBe(false);
  });
});
