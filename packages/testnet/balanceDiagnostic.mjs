/**
 * Read-only multichain testnet balance diagnostic.
 * Never invents balances. Never exposes private keys.
 */
import { createHash } from "node:crypto";

export const TESTNET_NETWORKS = Object.freeze({
  near_testnet: Object.freeze({
    id: "near_testnet",
    display: "NEAR testnet",
    rpc: process.env.NEAR_RPC || "https://test.rpc.fastnear.com",
  }),
  ethereum_sepolia: Object.freeze({
    id: "ethereum_sepolia",
    display: "Ethereum Sepolia",
    chain_id: 11155111,
    rpc:
      process.env.SEPOLIA_RPC ||
      "https://ethereum-sepolia-rpc.publicnode.com",
    usdc: "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2",
    usdc_decimals: 6,
  }),
  arbitrum_sepolia: Object.freeze({
    id: "arbitrum_sepolia",
    display: "Arbitrum Sepolia",
    chain_id: 421614,
    rpc:
      process.env.ARB_SEPOLIA_RPC ||
      "https://sepolia-rollup.arbitrum.io/rpc",
    usdc: "0x38d81431B9f76d9699AF7517040D5221D9dEA252",
    usdc_decimals: 6,
  }),
  base_sepolia: Object.freeze({
    id: "base_sepolia",
    display: "Base Sepolia",
    chain_id: 84532,
    rpc: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
    usdc: "0x38d81431B9f76d9699AF7517040D5221D9dEA252",
    usdc_decimals: 6,
  }),
});

function padAddr(a) {
  return String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function evmRpc(rpc, method, params) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

function human(raw, decimals) {
  const n = BigInt(String(raw || "0"));
  const d = BigInt(10) ** BigInt(decimals);
  const whole = n / d;
  const frac = n % d;
  return `${whole}.${frac.toString().padStart(decimals, "0")}`.replace(
    /\.?0+$/,
    (m) => (m.includes(".") ? "" : m)
  );
}

export async function diagnoseEvmToken({
  network,
  address,
  token,
  decimals,
  symbol = "USDC",
}) {
  const verified_at = new Date().toISOString();
  if (!address) {
    return {
      network: network.id,
      chain_id: network.chain_id,
      account: null,
      token_contract: token,
      symbol,
      status: "ADDRESS_MISSING",
      verified_at,
    };
  }
  try {
    const block = await evmRpc(network.rpc, "eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    const ethWei = await evmRpc(network.rpc, "eth_getBalance", [
      address,
      "latest",
    ]);
    const data = "0x70a08231" + padAddr(address);
    const tokenHex = await evmRpc(network.rpc, "eth_call", [
      { to: token, data },
      "latest",
    ]);
    const raw = BigInt(tokenHex || "0x0").toString();
    const gas = BigInt(ethWei || "0x0").toString();
    let status = "VERIFIED_ZERO";
    if (BigInt(raw) > 0n) status = "VERIFIED_POSITIVE";
    if (BigInt(raw) > 0n && BigInt(gas) === 0n) status = "GAS_UNFUNDED";
    return {
      network: network.id,
      display: network.display,
      chain_id: network.chain_id,
      account: address.toLowerCase(),
      token_contract: token,
      symbol,
      decimals,
      raw_token_balance: raw,
      human_token_balance: human(raw, decimals),
      native_gas_wei: gas,
      native_gas_eth: human(gas, 18),
      rpc: network.rpc,
      block_number: block?.number || null,
      block_hash: block?.hash || null,
      verified_at,
      status,
    };
  } catch (e) {
    return {
      network: network.id,
      chain_id: network.chain_id,
      account: address?.toLowerCase?.() || address,
      token_contract: token,
      status: "UNAVAILABLE",
      error: String(e.message || e).slice(0, 200),
      verified_at,
      rpc: network.rpc,
    };
  }
}

export async function diagnoseNearAccount({ accountId, rpc }) {
  const verified_at = new Date().toISOString();
  if (!accountId) {
    return {
      network: "near_testnet",
      account: null,
      status: "ADDRESS_MISSING",
      verified_at,
    };
  }
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "near",
        method: "query",
        params: {
          request_type: "view_account",
          finality: "final",
          account_id: accountId,
        },
      }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.data || j.error.message || "near_query");
    const amount = j.result?.amount || "0";
    const status = BigInt(amount) > 0n ? "VERIFIED_POSITIVE" : "VERIFIED_ZERO";
    return {
      network: "near_testnet",
      display: "NEAR testnet",
      account: accountId,
      token_contract: "native",
      symbol: "NEAR",
      decimals: 24,
      raw_token_balance: String(amount),
      human_token_balance: human(amount, 24),
      native_gas_wei: String(amount),
      rpc,
      block_height: j.result?.block_height || null,
      verified_at,
      status,
    };
  } catch (e) {
    return {
      network: "near_testnet",
      account: accountId,
      status: "UNAVAILABLE",
      error: String(e.message || e).slice(0, 200),
      verified_at,
      rpc,
    };
  }
}

/**
 * Full diagnostic for portfolio A (default Gate K canary).
 */
export async function diagnosePortfolioA(opts = {}) {
  const mpc =
    opts.mpcEvm ||
    "0x30af279bedef3bb82c7f47bb9f6a514f6264e752";
  const policy =
    opts.policyAccount || "policy.nio-i-a4e7-a-owner.testnet";
  const nearRpc =
    opts.nearRpc || TESTNET_NETWORKS.near_testnet.rpc;

  const rows = await Promise.all([
    diagnoseNearAccount({ accountId: policy, rpc: nearRpc }),
    diagnoseEvmToken({
      network: TESTNET_NETWORKS.ethereum_sepolia,
      address: mpc,
      token: TESTNET_NETWORKS.ethereum_sepolia.usdc,
      decimals: 6,
    }),
    diagnoseEvmToken({
      network: TESTNET_NETWORKS.arbitrum_sepolia,
      address: mpc,
      token: TESTNET_NETWORKS.arbitrum_sepolia.usdc,
      decimals: 6,
    }),
    diagnoseEvmToken({
      network: TESTNET_NETWORKS.base_sepolia,
      address: mpc,
      token: TESTNET_NETWORKS.base_sepolia.usdc,
      decimals: 6,
    }),
  ]);

  const explanation = {
    mainnet_matrix_no_trade:
      "scripts/mainnet/multichain-quote-matrix.mjs passed balances:{} intentionally — capitalAvailable returned no_balance_entry because no verified mainnet balance map was supplied. That is ADDRESS/ASSOC omission for mainnet portfolio funding, not proof that Sepolia balances are zero.",
    testnet_live_reads:
      "Gate J/K verify Sepolia USDC on intents_signer_id only today. Arb/Base Sepolia were not in the balance reader; zero there means unverified-for-trading until faucet + reader + chain-id policy binding exist.",
    portfolio_a_mpc: mpc,
    portfolio_a_policy: policy,
  };

  return {
    ok: true,
    portfolio_id: "i-a-a4e7",
    mpc_evm: mpc.toLowerCase(),
    policy_account: policy,
    rows,
    positive_funding_networks: rows
      .filter((r) => r.status === "VERIFIED_POSITIVE" || r.status === "GAS_UNFUNDED")
      .map((r) => r.network),
    explanation,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(rows.map((r) => [r.network, r.raw_token_balance, r.status])))
      .digest("hex")
      .slice(0, 16),
  };
}
