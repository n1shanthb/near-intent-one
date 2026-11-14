#!/usr/bin/env node
/**
 * J16 P1 — Real Anvil EVM node ERC-20 transfer proof.
 * Requires anvil on PATH (Foundry). Deploys a minimal ERC-20, transfers,
 * verifies mined receipt + Transfer log + balance deltas from the node.
 * HARD STOP: local anvil only — no mainnet.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import {
  signEip155WithLocalKey,
  validateSignedRawAgainstPolicy,
  verifySettlementFromReceipt,
} from "../../packages/autonomous/signedTxPipeline.mjs";
import { erc20TransferData } from "../../packages/intents-codec/quote-auth.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const ANVIL =
  process.env.ANVIL_BIN ||
  [
    join(process.env.USERPROFILE || "", ".foundry", "bin", "anvil.exe"),
    "anvil",
  ].find((p) => p === "anvil" || existsSync(p));

const PORT = Number(process.env.J16_ANVIL_PORT || 8545);
const RPC = `http://127.0.0.1:${PORT}`;
// Anvil default account #0
const PK0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDR0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DEST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil #1

const report = {
  kind: "J16_ANVIL_ERC20_PROOF",
  started_at: new Date().toISOString(),
  hard_stop_mainnet: true,
  anvil_bin: ANVIL,
  rpc: RPC,
  gates: {},
};

async function eth(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitAnvil(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const id = await eth("eth_chainId", []);
      if (id) return id;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error("anvil_not_ready");
}

/**
 * Minimal ERC20 bytecode (constructor mints max to deployer).
 * Compiled offline from a tiny Solidity contract; creation code embeds name/symbol.
 * Fallback: use eth_sendTransaction to deploy via cast if FORGE available.
 */
async function deployViaCast(castBin) {
  const sol = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract MockUSDC {
  string public name = "MockUSDC";
  string public symbol = "mUSDC";
  uint8 public decimals = 6;
  uint256 public totalSupply;
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);
  constructor() {
    uint256 a = 1_000_000_000_000; // 1e12 * 1e0 raw (1e6 units * 1e6)
    totalSupply = a;
    balanceOf[msg.sender] = a;
    emit Transfer(address(0), msg.sender, a);
  }
  function transfer(address to, uint256 v) external returns (bool) {
    require(balanceOf[msg.sender] >= v, "bal");
    balanceOf[msg.sender] -= v;
    balanceOf[to] += v;
    emit Transfer(msg.sender, to, v);
    return true;
  }
  function approve(address s, uint256 v) external returns (bool) {
    allowance[msg.sender][s] = v;
    emit Approval(msg.sender, s, v);
    return true;
  }
}
`;
  const solPath = join(EVIDENCE, "j16-MockUSDC.sol");
  writeFileSync(solPath, sol);
  // Prefer forge create
  return new Promise((resolve, reject) => {
    const args = [
      "create",
      solPath + ":MockUSDC",
      "--rpc-url",
      RPC,
      "--private-key",
      PK0,
      "--broadcast",
      "--json",
    ];
    const child = spawn(castBin.replace(/anvil(\.exe)?$/i, "forge$1"), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("close", (code) => {
      const combined = `${out}\n${err}`;
      if (code !== 0 && !/"deployedTo"/.test(combined)) {
        reject(new Error(`forge_create_failed:${err || out}`));
        return;
      }
      try {
        const m = combined.match(/deployedTo["\s:]+(0x[a-fA-F0-9]{40})/i);
        if (m) {
          resolve(m[1]);
          return;
        }
        reject(new Error(`forge_parse_no_address:${combined.slice(0, 500)}`));
      } catch (e) {
        reject(new Error(`forge_parse:${combined.slice(0, 500)}:${e.message}`));
      }
    });
  });
}

async function erc20Balance(token, addr) {
  const data =
    "0x70a08231" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const raw = await eth("eth_call", [{ to: token, data }, "latest"]);
  return BigInt(raw || "0x0").toString();
}

function findBin(name) {
  const base = dirname(ANVIL === "anvil" ? "anvil" : ANVIL);
  const candidates = [
    join(base, name + (process.platform === "win32" ? ".exe" : "")),
    name,
  ];
  return candidates.find((p) => p === name || existsSync(p));
}

if (!ANVIL || (ANVIL !== "anvil" && !existsSync(ANVIL))) {
  report.verdict = "NO_GO";
  report.error = "anvil_not_installed";
  report.gates.REAL_EVM_NODE_EXECUTION = "NO-GO";
  writeFileSync(
    join(EVIDENCE, "J16_ANVIL_ERC20_PROOF.json"),
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify({ verdict: report.verdict, error: report.error }, null, 2));
  process.exit(1);
}

const anvil = spawn(
  ANVIL,
  ["--port", String(PORT), "--chain-id", "31337", "--silent"],
  { stdio: ["ignore", "pipe", "pipe"] }
);
let anvilErr = "";
anvil.stderr.on("data", (d) => (anvilErr += d.toString()));

try {
  const chainIdHex = await waitAnvil();
  report.chain_id = Number(BigInt(chainIdHex));

  const forge = findBin("forge");
  if (!forge) throw new Error("forge_not_found_beside_anvil");
  const token = String(await deployViaCast(forge)).toLowerCase();
  report.token = token;
  if (!token.startsWith("0x") || token.length !== 42) {
    throw new Error(`bad_token:${token}`);
  }

  const amount = "1000000";
  const beforeSender = await erc20Balance(token, ADDR0);
  const beforeDest = await erc20Balance(token, DEST);

  const nonceHex = await eth("eth_getTransactionCount", [ADDR0, "pending"]);
  const nonce = Number(BigInt(nonceHex));
  const gasPrice = await eth("eth_gasPrice", []);
  const locked = {
    nonce,
    gasPrice: BigInt(gasPrice).toString(),
    gasLimit: "100000",
    token,
    depositAddress: DEST,
    amount,
    chainId: 31337,
    expectedMpc: ADDR0,
  };

  const signed = signEip155WithLocalKey({
    privateKeyHex: PK0,
    ...locked,
  });
  if (!signed.ok) throw new Error(signed.reason);

  const validated = validateSignedRawAgainstPolicy({
    signedRawHex: signed.rawHex,
    expected: {
      chainId: 31337,
      nonce,
      token,
      mpc: ADDR0,
      depositAddress: DEST,
      amount,
      digestHex: signed.digest_hex,
    },
  });
  report.validate = { ok: validated.ok, blockers: validated.blockers };

  const txHash = await eth("eth_sendRawTransaction", [signed.rawHex]);
  report.broadcast = { tx_hash: txHash };

  // replay must fail
  let replayRejected = false;
  try {
    await eth("eth_sendRawTransaction", [signed.rawHex]);
  } catch {
    replayRejected = true;
  }
  report.replay_rejected = replayRejected;

  let receipt = null;
  for (let i = 0; i < 30; i++) {
    receipt = await eth("eth_getTransactionReceipt", [txHash]);
    if (receipt) break;
    await sleep(200);
  }
  if (!receipt) throw new Error("receipt_timeout");
  receipt.from_node = true;

  const afterSender = await erc20Balance(token, ADDR0);
  const afterDest = await erc20Balance(token, DEST);

  const settle = verifySettlementFromReceipt({
    receipt,
    expected: {
      mpc: ADDR0,
      token,
      depositAddress: DEST,
      amount,
    },
    requireRealNode: true,
    balanceDelta: {
      beforeSender,
      afterSender,
      beforeDest,
      afterDest,
      amount,
    },
  });
  report.settle = settle;
  report.balances = { beforeSender, afterSender, beforeDest, afterDest };

  report.gates.REAL_EVM_NODE_EXECUTION = settle.ok ? "PASS" : "FAIL";
  report.gates.TOKEN_TRANSFER_VERIFIED = settle.ok ? "PASS" : "FAIL";
  report.verdict = settle.ok && replayRejected ? "PASS" : "NO_GO";
  report.explorer_note = "local anvil — no public explorer URL";
  report.finished_at = new Date().toISOString();
} catch (e) {
  report.verdict = "NO_GO";
  report.error = String(e.message || e).slice(0, 800);
  report.anvil_stderr = anvilErr.slice(0, 400);
  report.gates.REAL_EVM_NODE_EXECUTION = "NO-GO";
  report.finished_at = new Date().toISOString();
} finally {
  try {
    anvil.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

writeFileSync(
  join(EVIDENCE, "J16_ANVIL_ERC20_PROOF.json"),
  JSON.stringify(report, null, 2)
);
console.log(
  JSON.stringify(
    {
      verdict: report.verdict,
      gates: report.gates,
      tx_hash: report.broadcast?.tx_hash,
      token: report.token,
      error: report.error || null,
      evidence: join(EVIDENCE, "J16_ANVIL_ERC20_PROOF.json"),
    },
    null,
    2
  )
);
process.exit(report.verdict === "PASS" ? 0 : 1);
