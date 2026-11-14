#!/usr/bin/env node
/**
 * J17 — Owner-authorized TESTNET claim/fund for MPC address.
 * Claims Tidepool USDC via on-chain faucet() using disposable Sepolia funder,
 * then forwards Sepolia ETH + USDC to MPC 0x9a82c26b…
 * HARD STOP: no mainnet.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { SEPOLIA_RPC, USDC_SEPOLIA } from "../lib/near-live.mjs";
import {
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
  serializeSignedTx,
} from "../../packages/intents-codec/quote-auth.mjs";
import { recoverFromHash } from "../../packages/gate-k/settle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
const FUNDER_PATH = join(ROOT, ".gate-i-data", "sepolia-funder.json");
mkdirSync(EVIDENCE, { recursive: true });

const MPC = "0x9a82c26b3d158cf4b657ab2a3ef9e5e6c2934d55";
const USDC = USDC_SEPOLIA;
const CHAIN_ID = 11155111;
const ETH_TO_MPC = 15_000_000_000_000_000n; // 0.015 ETH
const USDC_TO_MPC = 2_000_000n; // 2.0
const FAUCET_DATA = Buffer.from("de5f72fd", "hex"); // faucet()

const report = {
  kind: "J17_CLAIM_AND_FUND_MPC",
  started_at: new Date().toISOString(),
  hard_stop_mainnet: true,
  mpc: MPC,
  token: USDC,
  authorization_note:
    "Owner instructed agent to claim testnet ETH and USDC for J17 funding.",
};

function evmAddressFromPriv(privBytes) {
  const pub = secp256k1.getPublicKey(privBytes, false);
  const hash = keccak_256(pub.slice(1));
  return "0x" + Buffer.from(hash.slice(12)).toString("hex");
}

function toDataBuf(data) {
  if (Buffer.isBuffer(data)) return data;
  if (!data || data === "0x") return Buffer.alloc(0);
  return Buffer.from(String(data).replace(/^0x/, ""), "hex");
}

function signGenericTx({
  privateKeyHex,
  nonce,
  gasPrice,
  gasLimit,
  to,
  data,
  value = 0n,
  chainId,
}) {
  const priv = Buffer.from(String(privateKeyHex).replace(/^0x/, ""), "hex");
  const dataBuf = toDataBuf(data);
  const digestBytes = eip155UnsignedDigest({
    nonce: BigInt(nonce),
    gasPrice: BigInt(gasPrice),
    gasLimit: BigInt(gasLimit),
    to,
    value: BigInt(value),
    data: dataBuf,
    chainId: Number(chainId),
  });
  const sig = secp256k1.sign(digestBytes, priv);
  const r = Buffer.from(sig.toCompactRawBytes().slice(0, 32));
  const s = Buffer.from(sig.toCompactRawBytes().slice(32, 64));
  const recoveryId = sig.recovery;
  const expected = evmAddressFromPriv(priv);
  const recovered = recoverFromHash(digestBytes, r, s, recoveryId);
  if (recovered.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`recovery_mismatch_${recovered}_vs_${expected}`);
  }
  const rawHex = serializeSignedTx({
    nonce: BigInt(nonce),
    gasPrice: BigInt(gasPrice),
    gasLimit: BigInt(gasLimit),
    to,
    value: BigInt(value),
    data: dataBuf,
    chainId: Number(chainId),
    r,
    s,
    recoveryId,
  });
  return { rawHex, digest_hex: digestHex(digestBytes), recovered: expected };
}

async function rpc(method, params = []) {
  const res = await fetch(SEPOLIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function bal(addr) {
  const data =
    "0x70a08231" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const [ethWei, usdcRaw] = await Promise.all([
    rpc("eth_getBalance", [addr, "latest"]),
    rpc("eth_call", [{ to: USDC, data }, "latest"]),
  ]);
  return {
    eth_wei: BigInt(ethWei).toString(),
    eth: Number(BigInt(ethWei)) / 1e18,
    usdc_raw: BigInt(usdcRaw || "0x0").toString(),
  };
}

async function waitReceipt(txHash, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await rpc("eth_getTransactionReceipt", [txHash]);
    if (r) return r;
    await new Promise((x) => setTimeout(x, 2000));
  }
  return null;
}

async function broadcast(rawHex) {
  const txHash = await rpc("eth_sendRawTransaction", [rawHex]);
  const receipt = await waitReceipt(txHash);
  return { tx_hash: txHash, receipt, explorer: `https://sepolia.etherscan.io/tx/${txHash}` };
}

function finish(code) {
  report.finished_at = new Date().toISOString();
  writeFileSync(
    join(EVIDENCE, "J17_CLAIM_AND_FUND_MPC.json"),
    JSON.stringify(report, null, 2)
  );
  console.log(
    JSON.stringify(
      {
        verdict: report.verdict,
        gates: report.gates,
        after: report.after,
        explorers: report.explorers,
        blocker: report.blocker || null,
        evidence: join(EVIDENCE, "J17_CLAIM_AND_FUND_MPC.json"),
      },
      null,
      2
    )
  );
  process.exit(code);
}

if (!existsSync(FUNDER_PATH)) {
  report.verdict = "NO_GO";
  report.blocker = "missing_.gate-i-data/sepolia-funder.json";
  finish(1);
}

const funderFile = JSON.parse(readFileSync(FUNDER_PATH, "utf8"));
const privateKey = funderFile.privateKey;
const privBytes = Buffer.from(String(privateKey).replace(/^0x/, ""), "hex");
const funderAddr = evmAddressFromPriv(privBytes).toLowerCase();
report.funder = funderAddr;

const chainId = Number(BigInt(await rpc("eth_chainId", [])));
if (chainId !== CHAIN_ID) {
  report.verdict = "NO_GO";
  report.blocker = `bad_chain_${chainId}`;
  finish(1);
}

report.before = { funder: await bal(funderAddr), mpc: await bal(MPC) };
console.log("before", JSON.stringify(report.before));

if (BigInt(report.before.funder.eth_wei) === 0n) {
  report.verdict = "NEED_SEPOLIA_ETH_FAUCET_FOR_FUNDER";
  report.blocker =
    "Funder has 0 Sepolia ETH — claim ETH to funder, then re-run to faucet USDC + forward to MPC.";
  report.claim_targets = {
    funder: funderAddr,
    mpc: MPC,
    eth_faucets: [
      "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
      "https://www.alchemy.com/faucets/ethereum-sepolia",
    ],
    usdc_note:
      "Tidepool USDC faucet() is on-chain at 0x2e6AD9… once funder has gas; Circle faucet is a different token.",
  };
  finish(2);
}

let nonce = Number(
  BigInt(await rpc("eth_getTransactionCount", [funderAddr, "pending"]))
);
let gasPrice = BigInt(await rpc("eth_gasPrice", []));
if (gasPrice < 1_000_000_000n) gasPrice = 1_000_000_000n;

try {
  // 1) Tidepool USDC faucet()
  if (BigInt(report.before.funder.usdc_raw) < USDC_TO_MPC) {
    const signed = signGenericTx({
      privateKeyHex: privateKey,
      nonce,
      gasPrice,
      gasLimit: 300000n,
      to: USDC,
      data: FAUCET_DATA,
      value: 0n,
      chainId: CHAIN_ID,
    });
    const res = await broadcast(signed.rawHex);
    report.usdc_faucet = res;
    console.log("usdc_faucet", res.tx_hash, res.receipt?.status);
    if (!res.receipt || res.receipt.status !== "0x1") {
      report.verdict = "USDC_FAUCET_FAILED";
      finish(1);
    }
    nonce += 1;
  } else {
    report.usdc_faucet = { skipped: true, reason: "funder_already_has_usdc" };
  }

  const mid = await bal(funderAddr);
  report.mid_funder = mid;

  // 2) ETH → MPC
  if (BigInt(report.before.mpc.eth_wei) < 10n ** 16n) {
    const sendEth =
      BigInt(mid.eth_wei) > ETH_TO_MPC + 5_000_000_000_000_000n
        ? ETH_TO_MPC
        : BigInt(mid.eth_wei) / 2n;
    if (sendEth < 5_000_000_000_000_000n) {
      report.verdict = "INSUFFICIENT_FUNDER_ETH_TO_FORWARD";
      finish(1);
    }
    const signed = signGenericTx({
      privateKeyHex: privateKey,
      nonce,
      gasPrice,
      gasLimit: 21000n,
      to: MPC,
      data: Buffer.alloc(0),
      value: sendEth,
      chainId: CHAIN_ID,
    });
    const res = await broadcast(signed.rawHex);
    report.eth_to_mpc = { ...res, amount_wei: sendEth.toString() };
    console.log("eth_to_mpc", res.tx_hash, res.receipt?.status);
    if (!res.receipt || res.receipt.status !== "0x1") {
      report.verdict = "ETH_TRANSFER_FAILED";
      finish(1);
    }
    nonce += 1;
  } else {
    report.eth_to_mpc = { skipped: true, reason: "mpc_already_funded_eth" };
  }

  // 3) USDC → MPC
  const funderUsdc = BigInt((await bal(funderAddr)).usdc_raw);
  const mpcUsdc = BigInt((await bal(MPC)).usdc_raw);
  const sendUsdc = funderUsdc >= USDC_TO_MPC ? USDC_TO_MPC : funderUsdc;
  if (sendUsdc > 0n && mpcUsdc < 1_000_000n) {
    const signed = signGenericTx({
      privateKeyHex: privateKey,
      nonce,
      gasPrice,
      gasLimit: 100000n,
      to: USDC,
      data: erc20TransferData(MPC, sendUsdc.toString()),
      value: 0n,
      chainId: CHAIN_ID,
    });
    const res = await broadcast(signed.rawHex);
    report.usdc_to_mpc = { ...res, amount_raw: sendUsdc.toString() };
    console.log("usdc_to_mpc", res.tx_hash, res.receipt?.status);
    if (!res.receipt || res.receipt.status !== "0x1") {
      report.verdict = "USDC_TRANSFER_FAILED";
      finish(1);
    }
  } else {
    report.usdc_to_mpc = {
      skipped: true,
      reason: sendUsdc === 0n ? "no_usdc" : "mpc_already_has_usdc",
    };
  }

  report.after = { funder: await bal(funderAddr), mpc: await bal(MPC) };
  const okEth = BigInt(report.after.mpc.eth_wei) >= 10n ** 16n;
  const okUsdc = BigInt(report.after.mpc.usdc_raw) >= 1_000_000n;
  report.gates = {
    SEPOLIA_ETH_CLAIMED_OR_FORWARDED: okEth ? "PASS" : "FAIL",
    SEPOLIA_USDC_CLAIMED_OR_FORWARDED: okUsdc ? "PASS" : "FAIL",
    SEPOLIA_FUNDING_CONFIRMED: okEth && okUsdc ? "PASS" : "PARTIAL",
  };
  report.explorers = {
    funder: `https://sepolia.etherscan.io/address/${funderAddr}`,
    mpc: `https://sepolia.etherscan.io/address/${MPC}`,
    eth_tx: report.eth_to_mpc?.explorer || null,
    usdc_faucet_tx: report.usdc_faucet?.explorer || null,
    usdc_tx: report.usdc_to_mpc?.explorer || null,
  };
  report.verdict = okEth && okUsdc ? "PASS" : "PARTIAL_OR_FAIL";
  finish(okEth && okUsdc ? 0 : 1);
} catch (e) {
  report.verdict = "NO_GO";
  report.error = String(e.message || e).slice(0, 1000);
  report.after = {
    funder: await bal(funderAddr).catch(() => null),
    mpc: await bal(MPC).catch(() => null),
  };
  finish(1);
}
