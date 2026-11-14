#!/usr/bin/env node
/**
 * J17 — Read-only Sepolia/MPC verification + exact TESTNET funding plan.
 *
 * HARD STOP: This script does NOT fund, mint, broadcast, or request MPC signatures
 * for EVM settlement. J17_SEPOLIA_FUNDING_AUTHORIZED alone is insufficient without
 * independently confirmed on-chain balances. This prompt does not authorize transfers.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pickRpc, MPC, SEPOLIA_RPC, USDC_SEPOLIA } from "../lib/near-live.mjs";
import { evmAddressFromNearSecpKey } from "../../packages/intents-codec/eip191.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const J16_MPC = "0x9a82c26b3d158cf4b657ab2a3ef9e5e6c2934d55";
const J16_PATH = "trading/v1/portfolio/j16-mpc-6890";
const J16_PREDECESSOR = "j16f6890.testnet";
const CIRCLE_USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const TIDEPOOL_USDC_SEPOLIA = USDC_SEPOLIA; // 0x2e6AD9… Gate-K / J16 pin

const MIN_ETH_WEI = 10n ** 16n; // 0.01 ETH
const MIN_TOKEN_RAW = 1_000_000n; // 1.0 token @ 6 decimals
const RECOMMENDED_ETH = "0.05";
const RECOMMENDED_TOKEN_RAW = "2000000";

async function eth(method, params = []) {
  const res = await fetch(SEPOLIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

function decodeAbiString(hex) {
  if (!hex || hex === "0x") return null;
  const h = hex.slice(2);
  if (h.length < 128) {
    try {
      return Buffer.from(h.replace(/00+$/, ""), "hex")
        .toString("utf8")
        .replace(/\0/g, "");
    } catch {
      return hex;
    }
  }
  const off = parseInt(h.slice(0, 64), 16) * 2;
  const len = parseInt(h.slice(off, off + 64), 16);
  return Buffer.from(h.slice(off + 64, off + 64 + len * 2), "hex").toString(
    "utf8"
  );
}

async function tokenMeta(token) {
  const [code, name, symbol, decimals] = await Promise.all([
    eth("eth_getCode", [token, "latest"]),
    eth("eth_call", [{ to: token, data: "0x06fdde03" }, "latest"]),
    eth("eth_call", [{ to: token, data: "0x95d89b41" }, "latest"]),
    eth("eth_call", [{ to: token, data: "0x313ce567" }, "latest"]),
  ]);
  return {
    address: token.toLowerCase(),
    code_bytes: Math.max(0, (code.length - 2) / 2),
    name: decodeAbiString(name),
    symbol: decodeAbiString(symbol),
    decimals: Number(BigInt(decimals || "0x0")),
  };
}

async function erc20Balance(token, holder) {
  const data =
    "0x70a08231" +
    holder.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const raw = await eth("eth_call", [{ to: token, data }, "latest"]);
  return BigInt(raw || "0x0");
}

async function deriveMpcEvm({ rpc, policyId, path }) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: MPC,
        method_name: "derived_public_key",
        args_base64: Buffer.from(
          JSON.stringify({ path, predecessor: policyId, domain_id: 0 })
        ).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) {
    throw new Error(JSON.stringify(j.error || j.result.error));
  }
  const raw = Buffer.from(j.result.result).toString("utf8");
  let key;
  try {
    key = JSON.parse(raw);
  } catch {
    key = raw.replace(/^"|"$/g, "");
  }
  if (typeof key === "object") key = key.public_key || key;
  const evm = evmAddressFromNearSecpKey(String(key)).toLowerCase();
  return { near_secp_key: key, evm_address: evm, path, predecessor: policyId };
}

const report = {
  kind: "J17_SEPOLIA_FUNDING_BOUNDARY",
  baseline: "ed2bd79",
  started_at: new Date().toISOString(),
  hard_stop_mainnet: true,
  hard_stop_testnet_transfer_without_funding_auth: true,
  note: "This prompt alone does not authorize Sepolia funding or transfers.",
  j16_target: {
    mpc_evm: J16_MPC,
    path: J16_PATH,
    predecessor: J16_PREDECESSOR,
    chain_id: 11155111,
    prior_near_mpc_tx:
      "https://testnet.nearblocks.io/txns/9eaSHcVf1vCDHp9tntxFx4LvVLdzp7zxNfUs4uG362X",
  },
};

try {
  const nearRpc = await pickRpc();
  const chainIdHex = await eth("eth_chainId", []);
  const chainId = Number(BigInt(chainIdHex));
  if (chainId !== 11155111) {
    throw new Error(`unexpected_chain_id_${chainId}`);
  }

  const derived = await deriveMpcEvm({
    rpc: nearRpc,
    policyId: J16_PREDECESSOR,
    path: J16_PATH,
  });

  const [ethWei, nonce, tideMeta, circleMeta, tideBal, circleBal, gasPrice] =
    await Promise.all([
      eth("eth_getBalance", [J16_MPC, "latest"]),
      eth("eth_getTransactionCount", [J16_MPC, "latest"]),
      tokenMeta(TIDEPOOL_USDC_SEPOLIA),
      tokenMeta(CIRCLE_USDC_SEPOLIA),
      erc20Balance(TIDEPOOL_USDC_SEPOLIA, J16_MPC),
      erc20Balance(CIRCLE_USDC_SEPOLIA, J16_MPC),
      eth("eth_gasPrice", []),
    ]);

  const ethBal = BigInt(ethWei);
  const matches =
    String(derived.evm_address).toLowerCase() === J16_MPC.toLowerCase();

  report.readonly_verify = {
    sepolia_rpc: SEPOLIA_RPC,
    chain_id: chainId,
    mpc_address: J16_MPC,
    explorer: `https://sepolia.etherscan.io/address/${J16_MPC}`,
    eth_wei: ethBal.toString(),
    eth_ether: Number(ethBal) / 1e18,
    nonce: Number(BigInt(nonce)),
    gas_price_wei: BigInt(gasPrice).toString(),
    derived_live: derived,
    derived_matches_j16_address: matches,
    tokens: {
      tidepool_j16_pin: {
        ...tideMeta,
        mpc_balance_raw: tideBal.toString(),
        provenance:
          "Tidepool community testnet USDC (name on-chain). NOT Circle official USDC. Used by Gate-K / J16 allowlists.",
        explorer: `https://sepolia.etherscan.io/token/${TIDEPOOL_USDC_SEPOLIA}`,
      },
      circle_official_sepolia: {
        ...circleMeta,
        mpc_balance_raw: circleBal.toString(),
        provenance:
          "Circle-listed Sepolia USDC (developers.circle.com). Faucet: https://faucet.circle.com — NOT the J16 mandate pin without allowlist update.",
        explorer: `https://sepolia.etherscan.io/token/${CIRCLE_USDC_SEPOLIA}`,
      },
    },
  };

  const fundedEth = ethBal >= MIN_ETH_WEI;
  const fundedTide = tideBal >= MIN_TOKEN_RAW;
  const fundedCircle = circleBal >= MIN_TOKEN_RAW;
  const fundedForPreferred = fundedEth && fundedTide;

  report.funding_plan = {
    destination: J16_MPC,
    network: "Ethereum Sepolia",
    chain_id: 11155111,
    never_use: ["mainnet ETH", "mainnet USDC", "any mainnet asset"],
    preferred_token: {
      label: "Tidepool Testnet USDC (J16 continuity)",
      address: TIDEPOOL_USDC_SEPOLIA.toLowerCase(),
      amount_raw: RECOMMENDED_TOKEN_RAW,
      amount_human: "2.0 (6 decimals)",
      how:
        "Obtain from Tidepool testnet faucet/ops for Sepolia ERC-20. Not mintable via Circle faucet. Confirm name() == Tidepool Testnet USDC before transfer.",
    },
    alternate_token: {
      label: "Circle official Sepolia USDC",
      address: CIRCLE_USDC_SEPOLIA.toLowerCase(),
      amount_raw: RECOMMENDED_TOKEN_RAW,
      faucet: "https://faucet.circle.com",
      caveat:
        "Requires separate mandate allowlist / asset pin update — do not treat as drop-in for J16 Tidepool pin.",
    },
    gas: {
      asset: "Sepolia ETH only",
      recommended_amount_eth: RECOMMENDED_ETH,
      min_confirm_wei: MIN_ETH_WEI.toString(),
      estimated_erc20_transfer_gas_limit: 100000,
      faucets: [
        {
          name: "Alchemy Sepolia",
          url: "https://www.alchemy.com/faucets/ethereum-sepolia",
          typical_drip: "0.1 ETH / 24h",
          notes:
            "Often requires ≥0.001 ETH mainnet balance + activity on the claiming wallet — claim to owner wallet then send Sepolia ETH to MPC address.",
        },
        {
          name: "Google Cloud Sepolia",
          url: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
          typical_drip: "~0.05 ETH / rate-limited",
          notes: "May require Google account; may check mainnet balance on claimer.",
        },
        {
          name: "Infura Sepolia",
          url: "https://docs.infura.io/how-to/get-testnet-tokens/",
          typical_drip: "~0.05 ETH / 24h",
          notes: "Account required; mainnet activity often required on claimer.",
        },
      ],
      procedure: [
        "1. Owner authorizes TESTNET funding in a separate explicit message (this file is not authorization).",
        "2. Claim Sepolia ETH to a disposable owner-controlled wallet via a listed faucet.",
        "3. Transfer Sepolia ETH to MPC address 0x9a82c26b3d158cf4b657ab2a3ef9e5e6c2934d55.",
        "4. Fund preferred Tidepool USDC (or authorize Circle USDC + allowlist change).",
        "5. Re-run this script; confirm SEPOLIA_FUNDING_CONFIRMED=PASS.",
        "6. Only then run scripts/j17/mpc-sepolia-broadcast.mjs with J17_SEPOLIA_FUNDING_AUTHORIZED=1.",
      ],
    },
    confirmation_thresholds: {
      eth_wei_min: MIN_ETH_WEI.toString(),
      preferred_token_raw_min: MIN_TOKEN_RAW.toString(),
      token: TIDEPOOL_USDC_SEPOLIA.toLowerCase(),
    },
  };

  const authEnv = process.env.J17_SEPOLIA_FUNDING_AUTHORIZED === "1";
  report.authorization = {
    env_J17_SEPOLIA_FUNDING_AUTHORIZED: authEnv,
    balances_meet_preferred_thresholds: fundedForPreferred,
    note: "Both env auth AND on-chain balances required before broadcast script may proceed.",
  };

  report.gates = {
    SEPOLIA_FUNDING_CONFIRMED: fundedForPreferred ? "PASS" : "WAITING_OWNER_FUNDING_AUTH",
    AUTHENTIC_MPC_TO_EVM_BROADCAST: "BLOCKED_AT_FUNDING_BOUNDARY",
    REAL_SEPOLIA_TOKEN_SETTLEMENT: "BLOCKED_AT_FUNDING_BOUNDARY",
    INDEPENDENT_RECONCILIATION: "BLOCKED_AT_FUNDING_BOUNDARY",
    UNATTENDED_KEEPER_READINESS: "PASS_SHADOW_FROM_J16",
    INTENTS_TESTNET: "NOT_AVAILABLE",
    MAINNET_UPGRADE_READINESS: "NO-GO",
    MAINNET_FUNDED_AUTONOMY_READINESS: "NO-GO",
  };

  report.intents_testnet = {
    verdict: "NOT_AVAILABLE",
    source: "https://docs.near-intents.org/resources/faqs",
    quote:
      "There is no testnet deployment and no plans for one. Official guidance: test on mainnet with separate small amounts under separate approval.",
    note: "Not an engineering failure. Mainnet Intents micro-canary requires separate owner approval.",
  };

  report.derived_matches_j16 = matches;
  report.verdict = fundedForPreferred
    ? authEnv
      ? "FUNDED_AND_AUTHORIZED_PROCEED_TO_BROADCAST_SCRIPT"
      : "FUNDED_BUT_AWAITING_EXPLICIT_AUTH_ENV"
    : "STOP_AT_FUNDING_AUTHORIZATION_BOUNDARY";

  // Prior evidence cross-check (nonsecret)
  const j16Path = join(EVIDENCE, "J16_MPC_EVM_TESTNET_ATTEMPT.json");
  if (existsSync(j16Path)) {
    const j16 = JSON.parse(readFileSync(j16Path, "utf8"));
    report.j16_cross_check = {
      prior_mpc: j16.accounts?.mpc_evm || j16.discovery?.mpc_evm?.evm_address,
      prior_path: j16.discovery?.mpc_evm?.path,
      prior_funding: j16.discovery?.funding,
      prior_mpc_sig_gate: j16.gates?.AUTHENTIC_NEAR_MPC_SIGNATURE,
    };
  }
} catch (e) {
  report.verdict = "NO_GO";
  report.error = String(e.message || e).slice(0, 1000);
  report.gates = {
    SEPOLIA_FUNDING_CONFIRMED: "FAIL_VERIFY",
    AUTHENTIC_MPC_TO_EVM_BROADCAST: "NO-GO",
    REAL_SEPOLIA_TOKEN_SETTLEMENT: "NO-GO",
    INDEPENDENT_RECONCILIATION: "NO-GO",
    UNATTENDED_KEEPER_READINESS: "PASS_SHADOW_FROM_J16",
    INTENTS_TESTNET: "NOT_AVAILABLE",
    MAINNET_UPGRADE_READINESS: "NO-GO",
    MAINNET_FUNDED_AUTONOMY_READINESS: "NO-GO",
  };
}

report.finished_at = new Date().toISOString();
const out = join(EVIDENCE, "J17_SEPOLIA_FUNDING_BOUNDARY.json");
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      verdict: report.verdict,
      gates: report.gates,
      funding: {
        eth_wei: report.readonly_verify?.eth_wei,
        tidepool_raw:
          report.readonly_verify?.tokens?.tidepool_j16_pin?.mpc_balance_raw,
        derived_matches: report.derived_matches_j16,
      },
      evidence: out,
    },
    null,
    2
  )
);
process.exit(0);
