/**
 * Explicit network profiles — never mix testnet and mainnet credentials/paths.
 * Default application mode remains TESTNET. MAINNET requires NIO_NETWORK=mainnet
 * plus separate authorization gates for signing / funded canary.
 */

export const NETWORK = Object.freeze({
  TESTNET: "testnet",
  MAINNET: "mainnet",
});

/** Official NEAR MPC / Chain Signatures contracts (docs.near.org). */
export const MPC_SIGNER = Object.freeze({
  testnet: "v1.signer-prod.testnet",
  mainnet: "v1.signer",
});

export const DOMAIN_SECP256K1 = 0;

export const TESTNET = Object.freeze({
  id: NETWORK.TESTNET,
  near: {
    networkId: "testnet",
    rpcs: [
      process.env.NEAR_RPC_TESTNET,
      process.env.NEAR_RPC,
      "https://test.rpc.fastnear.com",
      "https://rpc.testnet.near.org",
    ].filter(Boolean),
    explorerAccount: (id) => `https://testnet.nearblocks.io/address/${id}`,
    explorerTx: (hash) => `https://testnet.nearblocks.io/txns/${hash}`,
  },
  mpc: {
    signer: MPC_SIGNER.testnet,
    domainId: DOMAIN_SECP256K1,
  },
  evm: {
    name: "sepolia",
    chainId: 11155111,
    rpc: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
    usdc: "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2",
  },
  intents: {
    kind: "tidepool_sandbox",
    verifier: "verifier.tidepool-sandbox.testnet",
    quoteBase: process.env.TIDEPOOL_URL || "https://www.usetidepool.tech",
    originAsset:
      "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet",
    destAsset: "nep141:wnear.tidepool-sandbox.testnet",
  },
  credentialsDir: ".near-credentials/testnet",
  demoPrefix: "nio-c-",
  /** Path prefix encoded in policy WASM — must match contracts/policy PATH_PREFIX */
  derivationPathPrefix: "trading/v1/portfolio",
});

export const MAINNET = Object.freeze({
  id: NETWORK.MAINNET,
  near: {
    networkId: "mainnet",
    rpcs: [
      process.env.NEAR_RPC_MAINNET,
      "https://rpc.mainnet.fastnear.com",
      "https://rpc.mainnet.near.org",
      "https://free.rpc.fastnear.com",
    ].filter(Boolean),
    explorerAccount: (id) => `https://nearblocks.io/address/${id}`,
    explorerTx: (hash) => `https://nearblocks.io/txns/${hash}`,
  },
  mpc: {
    signer: MPC_SIGNER.mainnet,
    domainId: DOMAIN_SECP256K1,
  },
  evm: {
    /** Production EVM — explicit; not Sepolia. Default Arbitrum One for USDC routes. */
    name: process.env.NIO_MAINNET_EVM || "arbitrum",
    chainId: Number(process.env.NIO_MAINNET_EVM_CHAIN_ID || 42161),
    rpc:
      process.env.NIO_MAINNET_EVM_RPC ||
      "https://arb1.arbitrum.io/rpc",
    /** Native USDC on Arbitrum — verify against live 1Click registry before funding. */
    usdc:
      process.env.NIO_MAINNET_USDC ||
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  intents: {
    kind: "near_intents_1click",
    apiBase:
      process.env.NIO_1CLICK_BASE || "https://1click.chaindefuser.com",
    /** Production intents contract / solver mesh — distinct from Tidepool sandbox. */
    verifier: process.env.NIO_MAINNET_INTENTS_VERIFIER || "intents.near",
    /** Example registry IDs from official 1Click docs — always re-check via /v0/tokens. */
    exampleOriginAsset:
      "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    exampleDestAsset: "nep141:wrap.near",
  },
  credentialsDir: ".near-credentials/mainnet",
  demoPrefix: "nio-c-", // still banned on mainnet
  derivationPathPrefix: "trading/v1/portfolio",
});

export function resolveNetwork(explicit) {
  const raw = String(
    explicit || process.env.NIO_NETWORK || process.env.NEAR_NETWORK || "testnet"
  )
    .trim()
    .toLowerCase();
  if (raw === "mainnet") return MAINNET;
  if (raw === "testnet") return TESTNET;
  throw new Error(`unsupported_network:${raw}`);
}

export function assertNetworkIsolation(profile, { allowMainnet = false } = {}) {
  if (profile.id === NETWORK.MAINNET && !allowMainnet) {
    throw new Error(
      "mainnet_blocked: set NIO_NETWORK=mainnet and pass allowMainnet only in dedicated mainnet tooling"
    );
  }
  if (profile.id === NETWORK.MAINNET) {
    if (profile.mpc.signer !== MPC_SIGNER.mainnet) {
      throw new Error("mainnet_mpc_signer_mismatch");
    }
    if (profile.intents.kind === "tidepool_sandbox") {
      throw new Error("mainnet_must_not_use_tidepool_sandbox");
    }
  }
  if (profile.id === NETWORK.TESTNET) {
    if (profile.mpc.signer === MPC_SIGNER.mainnet) {
      throw new Error("testnet_must_not_use_mainnet_signer");
    }
  }
}

/** Hard gates for any funded mainnet action. All default OFF. */
export function mainnetAuthGates(env = process.env) {
  return {
    network_is_mainnet:
      String(env.NIO_NETWORK || env.NEAR_NETWORK || "").toLowerCase() ===
      "mainnet",
    mainnet_mode: env.NIO_MAINNET_MODE === "1",
    allow_sign: env.NIO_MAINNET_ALLOW_SIGN === "1",
    allow_broadcast: env.NIO_MAINNET_ALLOW_BROADCAST === "1",
    canary_approved: env.NIO_MAINNET_CANARY_APPROVED === "1",
    /** Public demo / Gate I OCI host must stay testnet. */
    public_demo_safe:
      String(env.NEAR_NETWORK || "testnet").toLowerCase() === "testnet",
  };
}

export function assertMainnetCanaryAuthorized(approval, env = process.env) {
  const gates = mainnetAuthGates(env);
  if (!gates.network_is_mainnet || !gates.mainnet_mode) {
    return { ok: false, reason: "mainnet_mode_off" };
  }
  if (!gates.canary_approved) {
    return { ok: false, reason: "canary_approval_flag_off" };
  }
  const required = [
    "owner_account",
    "chain",
    "policy_contract",
    "source_token",
    "destination_token",
    "max_at_risk",
    "max_fees",
    "destination_address",
    "refund_address",
    "purpose",
  ];
  for (const k of required) {
    if (!approval?.[k]) return { ok: false, reason: `missing_${k}` };
  }
  if (!String(approval.owner_account).endsWith(".near")) {
    return { ok: false, reason: "owner_must_be_mainnet_account" };
  }
  if (String(approval.owner_account).startsWith(MAINNET.demoPrefix)) {
    return { ok: false, reason: "demo_owner_banned" };
  }
  if (!gates.allow_sign) {
    return { ok: false, reason: "mainnet_signing_off", gates, approval };
  }
  return { ok: true, gates, approval };
}
