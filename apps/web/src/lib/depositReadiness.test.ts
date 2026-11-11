import { describe, expect, it } from "vitest";
import { MAINNET_EVIDENCE } from "../data/mainnetEvidence";
import {
  classifyDepositChain,
  evaluateDepositReadiness,
  isFundableDepositInstructionAllowed,
  publicMainnetDepositsAllowed,
} from "./depositReadiness";

describe("deposit readiness", () => {
  it("hard-locks public mainnet deposits this sprint", () => {
    expect(publicMainnetDepositsAllowed()).toBe(false);
  });

  it("classifies mainnet-like vs testnet-like chains", () => {
    expect(classifyDepositChain("ethereum")).toBe("mainnet_like");
    expect(classifyDepositChain("arbitrum")).toBe("mainnet_like");
    expect(classifyDepositChain("base")).toBe("mainnet_like");
    expect(classifyDepositChain("mainnet")).toBe("mainnet_like");
    expect(classifyDepositChain("sepolia")).toBe("testnet_like");
    expect(classifyDepositChain("near")).toBe("testnet_like");
  });

  it("blocks mainnet deposit addresses with explicit safety copy", () => {
    const r = evaluateDepositReadiness({
      chain: "ethereum",
      ownerVerified: true,
      ownerAccountId: "alice.near",
      portfolioId: "personal-1",
      portfolioOwner: "alice.near",
      policyContract: "policy.alice.near",
      intentsSignerId: "0xabc",
      backendReady: true,
      portfolioStatus: "ready",
      evidence: MAINNET_EVIDENCE,
    });
    expect(r.allowed).toBe(false);
    expect(r.message).toBe(
      "Mainnet deposits are not enabled. Do not send funds."
    );
    expect(isFundableDepositInstructionAllowed(r)).toBe(false);
    expect(r.checks.some((c) => !c.ok)).toBe(true);
  });

  it("blocks unauthenticated and demo portfolio deposits on testnet", () => {
    const unauth = evaluateDepositReadiness({
      chain: "sepolia",
      ownerVerified: false,
      portfolioId: "personal-1",
    });
    expect(unauth.allowed).toBe(false);
    expect(unauth.reason).toBe("owner_session_required");

    const demo = evaluateDepositReadiness({
      chain: "sepolia",
      ownerVerified: true,
      ownerAccountId: "alice.testnet",
      portfolioId: "i-a-a4e7",
      portfolioOwner: "alice.testnet",
    });
    expect(demo.allowed).toBe(false);
  });

  it("never treats empty evidence as deposit-ready", () => {
    expect(MAINNET_EVIDENCE.capabilities.deposit_capability_enabled).toBe(
      false
    );
    expect(MAINNET_EVIDENCE.capabilities.live_trading_enabled).toBe(false);
  });
});
