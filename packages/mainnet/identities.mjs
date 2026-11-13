/**
 * Canonical mainnet NIO identities for Checkpoint J3+.
 * Mandate epoch is loaded from chain — never hardcoded as authority.
 */
export const MAINNET_IDENTITIES = Object.freeze({
  network: "mainnet",
  owner: "nishanthb.near",
  policy: "policy.nishanthb.near",
  agent: "agent.nishanthb.near",
  portfolio_id: "nio-mainnet-v1",
  derivation_path: "trading/v1/portfolio/nio-mainnet-v1",
  /** Expected software ops FullAccess on agent only. */
  ops_public_key: "ed25519:DZUECSrU7kcqzN1PcSBGRgqf6uegsbTFxQ8wbDBxEbgJ",
  /** Ledger administrative FullAccess on agent. */
  ledger_public_key: "ed25519:7AMsxZH3HdjRj9twcR2aXyVUdYJZNzgy6ZeRajwkBx58",
  /** Verified MPC EVM destination (I2). */
  mpc_evm_address: "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4",
  mpc_signer: "v1.signer",
});

/** Native USDC contract addresses used for balance reads (not symbol-only). */
export const MAINNET_USDC = Object.freeze({
  ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
});

export const MAINNET_EVM_RPCS = Object.freeze({
  ethereum:
    process.env.NIO_ETH_RPC || "https://ethereum-rpc.publicnode.com",
  arbitrum:
    process.env.NIO_ARB_RPC ||
    process.env.NIO_MAINNET_EVM_RPC ||
    "https://arb1.arbitrum.io/rpc",
  base: process.env.NIO_BASE_RPC || "https://mainnet.base.org",
});
