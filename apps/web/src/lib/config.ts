/** Defaults from live Gate C/D/E evidence. Override via Vite env. */
export const CONFIG = {
  network: "testnet" as const,
  policyContract:
    import.meta.env.VITE_POLICY_CONTRACT_ID ?? "nio-c-policy-857107.testnet",
  ownerAccount:
    import.meta.env.VITE_OWNER_ACCOUNT_ID ?? "nio-c-owner-857107.testnet",
  agentAccount:
    import.meta.env.VITE_AGENT_ACCOUNT_ID ?? "nio-c-agent-857107.testnet",
  mpcEvm: "0xcbf7bb47087ec07be2936ce80aaea60e4457fdd4",
  sepoliaUsdc: "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2",
  originAsset:
    "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet",
  destAsset: "nep141:wnear.tidepool-sandbox.testnet",
  tidepoolQuotePath: "/tidepool/v0/quote",
  nearRpcPath: "/near-rpc",
  nearblocks: "https://testnet.nearblocks.io",
  etherscan: "https://sepolia.etherscan.io",
};
