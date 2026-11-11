/**
 * Network-aware helpers — never relabel testnet receipts as mainnet.
 */
import {
  MAINNET_EVIDENCE,
  hasVerifiedMainnetContract,
  type MainnetCapability,
  type MainnetEvidenceRecord,
  type NearNetworkId,
} from "../data/mainnetEvidence";
import { CONFIG } from "./config";

export type WorkspaceNetworkContext = {
  /** Network the public demo / BFF health reports. */
  active: NearNetworkId;
  /** Whether independently verified NIO mainnet contract proof exists. */
  mainnetProofReady: boolean;
  label: string;
  explorerHost: string;
  nearblocksBase: string;
  etherscanBase: string;
};

const EXPLORERS: Record<
  NearNetworkId,
  { nearblocks: string; etherscan: string; label: string }
> = {
  testnet: {
    nearblocks: "https://testnet.nearblocks.io",
    etherscan: "https://sepolia.etherscan.io",
    label: "NEAR Testnet",
  },
  mainnet: {
    nearblocks: "https://nearblocks.io",
    etherscan: "https://etherscan.io",
    label: "NEAR Mainnet",
  },
};

/** Active workspace network from env / defaults — demo remains testnet. */
export function activeWorkspaceNetwork(): NearNetworkId {
  const raw = (import.meta.env.VITE_NETWORK || CONFIG.network || "testnet")
    .toString()
    .toLowerCase();
  return raw === "mainnet" ? "mainnet" : "testnet";
}

export function workspaceNetworkContext(
  healthNetwork?: string | null
): WorkspaceNetworkContext {
  const fromHealth =
    typeof healthNetwork === "string" && healthNetwork.toLowerCase() === "mainnet"
      ? "mainnet"
      : typeof healthNetwork === "string" &&
          healthNetwork.toLowerCase() === "testnet"
        ? "testnet"
        : null;
  const active = fromHealth ?? activeWorkspaceNetwork();
  const explorers = EXPLORERS[active];
  return {
    active,
    mainnetProofReady: hasVerifiedMainnetContract(),
    label: explorers.label,
    explorerHost: explorers.nearblocks,
    nearblocksBase: explorers.nearblocks,
    etherscanBase: explorers.etherscan,
  };
}

export function nearTxExplorerUrl(
  network: NearNetworkId,
  txHash: string | null | undefined
): string | null {
  if (!txHash || !/^[A-Za-z0-9]+$/.test(txHash)) return null;
  return `${EXPLORERS[network].nearblocks}/txns/${txHash}`;
}

export function nearAccountExplorerUrl(
  network: NearNetworkId,
  accountId: string | null | undefined
): string | null {
  if (!accountId || !/^[a-z0-9._-]+$/i.test(accountId)) return null;
  // Refuse testnet accounts on mainnet explorers and vice versa by suffix heuristic.
  if (network === "mainnet" && accountId.endsWith(".testnet")) return null;
  if (network === "testnet" && accountId.endsWith(".near") && !accountId.includes("testnet")) {
    // .near accounts belong on mainnet explorers
    return null;
  }
  return `${EXPLORERS[network].nearblocks}/address/${accountId}`;
}

/** Mainnet-only explorer helpers — return null unless evidence network is mainnet. */
export function mainnetAccountExplorer(
  accountId: string | null | undefined,
  ev: MainnetEvidenceRecord = MAINNET_EVIDENCE
): string | null {
  if (ev.network !== "mainnet") return null;
  return nearAccountExplorerUrl("mainnet", accountId);
}

export function mainnetTxExplorer(
  txHash: string | null | undefined,
  ev: MainnetEvidenceRecord = MAINNET_EVIDENCE
): string | null {
  if (ev.network !== "mainnet") return null;
  return nearTxExplorerUrl("mainnet", txHash);
}

export const CAPABILITY_LABELS: Record<MainnetCapability, string> = {
  contract_deployed: "Mainnet contract deployed",
  policy_active: "Mainnet policy active",
  mpc_ready: "MPC ready",
  live_trading_enabled: "Live trading enabled",
  funded_settlement_proven: "Funded settlement proven",
};

export function capabilityTone(
  enabled: boolean
): "success" | "idle" | "danger" {
  return enabled ? "success" : "idle";
}

/** Owner trading on mainnet stays locked until Chat 1 confirms gates. */
export function mainnetTradingControlsEnabled(
  ev: MainnetEvidenceRecord = MAINNET_EVIDENCE
): boolean {
  return Boolean(
    ev.capabilities.live_trading_enabled &&
      ev.capabilities.contract_deployed &&
      ev.capabilities.policy_active &&
      ev.capabilities.mpc_ready
  );
}
