import { describe, expect, it } from "vitest";
import {
  NISHANTH_PUBLIC,
  WORKSPACE_STORAGE_KEY,
  isNishanthAccount,
  type WorkspaceMode,
} from "../lib/workspaceIds";
import { hasVerifiedMainnetContract } from "../data/mainnetEvidence";
import { mainnetDepositControlsEnabled } from "../lib/network";

describe("two-workspace identities", () => {
  it("defaults public showcase to Nishanth mainnet identities", () => {
    const mode: WorkspaceMode = "nishanth_public";
    expect(mode).toBe("nishanth_public");
    expect(NISHANTH_PUBLIC.owner).toBe("nishanthb.near");
    expect(NISHANTH_PUBLIC.agent).toBe("agent.nishanthb.near");
    expect(NISHANTH_PUBLIC.policy).toBe("policy.nishanthb.near");
    expect(NISHANTH_PUBLIC.portfolio_id).toBe("nio-mainnet-v1");
    expect(NISHANTH_PUBLIC.network).toBe("mainnet");
  });

  it("does not treat arbitrary accounts as Nishanth", () => {
    expect(isNishanthAccount("alice.near")).toBe(false);
    expect(isNishanthAccount("nishanthb.near")).toBe(true);
    expect(isNishanthAccount(null)).toBe(false);
  });

  it("keeps workspace storage key stable", () => {
    expect(WORKSPACE_STORAGE_KEY).toBe("nio.workspace.mode.v1");
  });

  it("mainnet proof is verified while deposits stay blocked", () => {
    expect(hasVerifiedMainnetContract()).toBe(true);
    expect(mainnetDepositControlsEnabled()).toBe(false);
  });
});
