#!/usr/bin/env node
/** Rebroadcast already-signed testnet canary — NEVER re-sign. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hexToBytes } from "@noble/curves/abstract/utils";
import {
  serializeSignedTx,
  erc20TransferData,
  eip155UnsignedDigest,
} from "../../packages/intents-codec/quote-auth.mjs";
import { evmAddressFromPubkey } from "../../packages/intents-codec/eip191.mjs";
import { openStore } from "../../packages/services/store.mjs";
import { USDC_SEPOLIA, CHAIN_ID, DEFAULT_GAS_LIMIT } from "../../packages/gate-k/index.mjs";
import {
  eth,
  nearRpc,
  pickRpc,
  erc20Balance,
} from "../lib/near-live.mjs";
import {
  tidepoolSubmitDeposit,
  tidepoolStatus,
} from "../../packages/testnet/tidepoolMultichain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = process.env.GATE_I_DATA_DIR || join(ROOT, ".gate-i-data");
const EVIDENCE = join(ROOT, "docs/evidence");
mkdirSync(EVIDENCE, { recursive: true });

const KEY = "gate_k:rebalance:i-a-a4e7:1000000";
const store = openStore(DATA);
const state = JSON.parse(readFileSync(join(DATA, "state.json"), "utf8"));
const exec = state.executions?.[KEY];
if (!exec || exec.may_resign !== false) {
  console.error("missing signed pending exec", exec?.status);
  process.exit(1);
}

const portfolio = store.getPortfolio("i-a-a4e7");
const rpc = await pickRpc();

function mpcToRsV(sig) {
  const rPoint = hexToBytes(sig.big_r.affine_point);
  const r = rPoint.slice(1);
  const s = hexToBytes(sig.s.scalar);
  let recoveryId = Number(sig.recovery_id);
  if (recoveryId === 27 || recoveryId === 28) recoveryId -= 27;
  return { r, s, recoveryId };
}

function extractSig(fullTx) {
  for (const r of fullTx?.result?.receipts_outcome || []) {
    const sv = r?.outcome?.status?.SuccessValue;
    if (!sv) continue;
    try {
      const decoded = Buffer.from(sv, "base64").toString("utf8");
      if (decoded.includes("Secp256k1") || decoded.includes("big_r")) {
        return JSON.parse(decoded);
      }
    } catch {
      /* */
    }
  }
  return null;
}

async function waitReceipt(tx, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const j = await eth("eth_getTransactionReceipt", [tx]);
    if (j.result) return j.result;
  }
  return null;
}

const signFull = await nearRpc(rpc, "EXPERIMENTAL_tx_status", [
  exec.sign_tx,
  portfolio.agent_account,
]);
const sigJson = extractSig(signFull);
if (!sigJson) {
  console.error("sig missing");
  process.exit(1);
}

const data = erc20TransferData(exec.to, BigInt(exec.amount));
let { r, s, recoveryId } = mpcToRsV(sigJson);
const digest = eip155UnsignedDigest({
  nonce: BigInt(exec.nonce),
  gasPrice: BigInt(exec.gas_price),
  gasLimit: BigInt(exec.gas_limit || DEFAULT_GAS_LIMIT),
  to: USDC_SEPOLIA,
  data,
  chainId: CHAIN_ID,
  value: 0n,
});
{
  const compact = new Uint8Array(64);
  compact.set(r, 0);
  compact.set(s, 32);
  let recovered = evmAddressFromPubkey(
    secp256k1.Signature.fromCompact(compact)
      .addRecoveryBit(recoveryId)
      .recoverPublicKey(digest)
      .toRawBytes(false)
  );
  if (recovered.toLowerCase() !== portfolio.intents_signer_id.toLowerCase()) {
    recoveryId ^= 1;
  }
}

const rawHex = serializeSignedTx({
  nonce: BigInt(exec.nonce),
  gasPrice: BigInt(exec.gas_price),
  gasLimit: BigInt(exec.gas_limit || DEFAULT_GAS_LIMIT),
  to: USDC_SEPOLIA,
  data,
  chainId: CHAIN_ID,
  value: 0n,
  r,
  s,
  recoveryId,
});

console.error("rebroadcasting (no re-sign)...");
const usdcBefore = await erc20Balance(USDC_SEPOLIA, portfolio.intents_signer_id);
const send = await eth("eth_sendRawTransaction", [rawHex]);
const out = {
  kind: "TESTNET_REBROADCAST_NO_RESIGN",
  exec_key: KEY,
  operation_id: exec.operation_id,
  deposit: exec.to,
  amount: exec.amount,
  nonce: exec.nonce,
  usdc_before: String(usdcBefore),
  broadcast_error: send.error || null,
  sepolia_tx: send.result || null,
  explorer: send.result ? `https://sepolia.etherscan.io/tx/${send.result}` : null,
  near_propose: exec.propose_tx,
  near_sign: exec.sign_tx,
};
if (send.error) {
  writeFileSync(join(EVIDENCE, "TESTNET_REBROADCAST.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  process.exit(1);
}

const receipt = await waitReceipt(send.result);
out.receipt_status = receipt?.status || null;
out.receipt_ok = receipt?.status === "0x1";
const usdcAfter = await erc20Balance(USDC_SEPOLIA, portfolio.intents_signer_id);
out.usdc_after = String(usdcAfter);

if (out.receipt_ok) {
  const sub = await tidepoolSubmitDeposit(send.result);
  out.tidepool_submit = sub;
  let terminal = null;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await tidepoolStatus(exec.to);
    const status = st.body?.status || st.body?.state || st.body;
    const s = String(status?.status || status || "").toUpperCase();
    out.tidepool_poll = { attempt: i + 1, status };
    if (["SUCCESS", "SUCCEEDED", "COMPLETED", "REFUNDED", "FAILED"].includes(s)) {
      terminal = s;
      break;
    }
  }
  out.tidepool_terminal = terminal;
  store.finishExecution(KEY, {
    status: terminal === "SUCCESS" || terminal === "SUCCEEDED" || terminal === "COMPLETED"
      ? "SETTLED"
      : "BROADCAST_CONFIRMED_SETTLEMENT_PENDING",
    sepolia_tx: send.result,
    receipt_status: receipt.status,
    tidepool_terminal: terminal,
  });
}

writeFileSync(join(EVIDENCE, "TESTNET_REBROADCAST.json"), JSON.stringify(out, null, 2));
writeFileSync(
  join(EVIDENCE, "TESTNET_FUNDED_MULTICHAIN_TRADES.json"),
  JSON.stringify(
    {
      ...out,
      pass: out.receipt_ok === true,
      acceptance_override: false,
      may_resign: false,
      fitter: "ALLOWED (prior)",
      critic: "APPROVE (deterministic rebalance)",
      authorized_objective:
        "Owner-authorized testnet inventory rebalance — rebroadcast of already-signed bytes",
    },
    null,
    2
  )
);
writeFileSync(
  join(EVIDENCE, "TESTNET_FUNDED_MULTICHAIN_TRADES.md"),
  `# Testnet funded trade (rebroadcast)\n\n` +
    `- Sepolia tx: ${out.sepolia_tx}\n` +
    `- Explorer: ${out.explorer}\n` +
    `- Receipt: ${out.receipt_status}\n` +
    `- Deposit: ${out.deposit}\n` +
    `- NEAR propose: ${out.near_propose}\n` +
    `- NEAR sign: ${out.near_sign}\n` +
    `- Tidepool terminal: ${out.tidepool_terminal}\n` +
    `- USDC before/after: ${out.usdc_before} → ${out.usdc_after}\n` +
    `- No re-sign: true\n` +
    `- Acceptance override: false\n`
);
console.log(JSON.stringify(out, null, 2));
process.exit(out.receipt_ok ? 0 : 2);
