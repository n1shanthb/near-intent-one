import { describe, expect, it } from "vitest";
import {
  MAINNET_EVIDENCE,
  hasVerifiedMainnetContract,
} from "../data/mainnetEvidence";
import {
  mainnetDepositControlsEnabled,
  mainnetTradingControlsEnabled,
  nearAccountExplorerUrl,
  nearTxExplorerUrl,
  workspaceNetworkContext,
} from "./network";

describe("network awareness", () => {
  it("defaults workspace to testnet and reports mainnet proof pending", () => {
    const ctx = workspaceNetworkContext("testnet");
    expect(ctx.active).toBe("testnet");
    expect(ctx.label).toContain("Testnet");
    expect(ctx.nearblocksBase).toContain("testnet.nearblocks");
    expect(hasVerifiedMainnetContract()).toBe(false);
    expect(ctx.mainnetProofReady).toBe(false);
  });

  it("builds chain-specific explorer links and refuses mismatches", () => {
    expect(nearTxExplorerUrl("testnet", "Abc123")).toBe(
      "https://testnet.nearblocks.io/txns/Abc123"
    );
    expect(nearTxExplorerUrl("mainnet", "Abc123")).toBe(
      "https://nearblocks.io/txns/Abc123"
    );
    expect(nearAccountExplorerUrl("mainnet", "alice.testnet")).toBeNull();
    expect(nearAccountExplorerUrl("mainnet", "nio.near")).toContain(
      "nearblocks.io/address/nio.near"
    );
    expect(nearAccountExplorerUrl("testnet", "nio.near")).toBeNull();
  });

  it("keeps mainnet trading disabled without verified capabilities", () => {
    expect(MAINNET_EVIDENCE.network).toBe("mainnet");
    expect(MAINNET_EVIDENCE.capabilities.live_trading_enabled).toBe(false);
    expect(mainnetTradingControlsEnabled()).toBe(false);
    expect(MAINNET_EVIDENCE.funded_trade.proven).toBe(false);
  });

  it("keeps mainnet deposits disabled without verified capabilities", () => {
    expect(MAINNET_EVIDENCE.capabilities.deposit_capability_enabled).toBe(
      false
    );
    expect(mainnetDepositControlsEnabled()).toBe(false);
  });
});
