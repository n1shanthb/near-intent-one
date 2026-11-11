/**
 * Post-MPC settlement helpers — broadcast, confirm, tidepool, reconcile.
 * Never re-signs. MPC signature ≠ settlement success.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { hexToBytes } from "@noble/curves/abstract/utils";
import {
  serializeSignedTx,
  erc20TransferData,
  eip155UnsignedDigest,
} from "../intents-codec/quote-auth.mjs";
import { evmAddressFromPubkey } from "../intents-codec/eip191.mjs";
import {
  CHAIN_ID,
  USDC_SEPOLIA,
  DEFAULT_GAS_LIMIT,
} from "./constants.mjs";
import { LIFECYCLE } from "./lifecycle.mjs";

export function extractMpcSigFromNearTx(fullTx) {
  const out = { found: false, signature_json: null };
  for (const r of fullTx?.result?.receipts_outcome || []) {
    const sv = r?.outcome?.status?.SuccessValue;
    if (!sv) continue;
    try {
      const decoded = Buffer.from(sv, "base64").toString("utf8");
      if (decoded.includes("Secp256k1") || decoded.includes("big_r")) {
        out.found = true;
        out.signature_json = JSON.parse(decoded);
      }
    } catch {
      /* */
    }
  }
  return out;
}

export function mpcToRsV(sig) {
  const rPoint = hexToBytes(sig.big_r.affine_point);
  const r = rPoint.slice(1);
  const s = hexToBytes(sig.s.scalar);
  let recoveryId = Number(sig.recovery_id);
  if (recoveryId === 27 || recoveryId === 28) recoveryId -= 27;
  return { r, s, recoveryId };
}

export function recoverFromHash(hash, r, s, recoveryId) {
  const compact = new Uint8Array(64);
  compact.set(r, 0);
  compact.set(s, 32);
  const pub = secp256k1.Signature.fromCompact(compact)
    .addRecoveryBit(recoveryId)
    .recoverPublicKey(hash);
  return evmAddressFromPubkey(pub.toRawBytes(false));
}

export async function waitEthReceipt(eth, txHash, { tries = 40, delayMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const j = await eth("eth_getTransactionReceipt", [txHash]);
    if (j.result) return j.result;
  }
  return null;
}

/**
 * Build + optionally broadcast signed ERC-20 transfer from stored MPC execution.
 * @param {object} deps { eth, nearRpc, rpcUrl, agentAccount }
 * @param {object} exec store execution with sign_tx, nonce, gas_price, amount, to, …
 * @param {object} portfolio
 * @param {{ dryRun?: boolean }} opts — dryRun=true never broadcasts
 */
export async function advanceBroadcast(deps, { exec, portfolio }, opts = {}) {
  const { eth, nearRpc, rpcUrl, agentAccount } = deps;
  const dryRun = opts.dryRun === true;

  if (exec.sepolia_tx) {
    return {
      ok: true,
      skipped: true,
      status: LIFECYCLE.BROADCAST,
      sepolia_tx: exec.sepolia_tx,
      note: "already_broadcast_no_resign",
    };
  }

  const full = await nearRpc(rpcUrl, "EXPERIMENTAL_tx_status", [
    exec.sign_tx,
    agentAccount || portfolio.agent_account,
  ]);
  const extracted = extractMpcSigFromNearTx(full);
  if (!extracted.found) {
    return {
      ok: false,
      status: LIFECYCLE.MPC_SIGNED,
      reason: "MPC_SIG_NOT_FOUND",
      retryable: true,
    };
  }

  const amount = String(exec.amount);
  const deposit = String(exec.to).toLowerCase();
  const nonce = BigInt(exec.nonce);
  const gasPrice = BigInt(exec.gas_price);
  const gasLimit = BigInt(exec.gas_limit || DEFAULT_GAS_LIMIT);
  const data = erc20TransferData(deposit, BigInt(amount));
  const digest = eip155UnsignedDigest({
    nonce,
    gasPrice,
    gasLimit,
    to: USDC_SEPOLIA,
    data,
    chainId: CHAIN_ID,
  });

  let { r, s, recoveryId } = mpcToRsV(extracted.signature_json);
  let recovered = recoverFromHash(digest, r, s, recoveryId);
  const expected = String(portfolio.intents_signer_id).toLowerCase();
  if (recovered.toLowerCase() !== expected) {
    const alt = recoveryId ^ 1;
    if (recoverFromHash(digest, r, s, alt).toLowerCase() === expected) {
      recoveryId = alt;
      recovered = expected;
    }
  }
  if (recovered.toLowerCase() !== expected) {
    return {
      ok: false,
      status: LIFECYCLE.FAILED,
      reason: "RECOVERED_ADDRESS_MISMATCH",
      retryable: false,
      recovered,
      expected,
    };
  }

  const raw = serializeSignedTx({
    nonce,
    gasPrice,
    gasLimit,
    to: USDC_SEPOLIA,
    data,
    chainId: CHAIN_ID,
    r,
    s,
    recoveryId,
  });

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      status: LIFECYCLE.MPC_SIGNED,
      raw_tx_len: raw.length,
      recovered,
      note: "broadcast_suppressed_dry_run",
    };
  }

  const send = await eth("eth_sendRawTransaction", [raw]);
  if (send.error || !send.result) {
    return {
      ok: false,
      status: LIFECYCLE.MPC_SIGNED,
      reason: "BROADCAST_FAILED",
      retryable: true,
      error: send.error || null,
    };
  }

  return {
    ok: true,
    status: LIFECYCLE.BROADCAST,
    sepolia_tx: send.result,
    explorer: `https://sepolia.etherscan.io/tx/${send.result}`,
    deposit_address: deposit,
    amount,
  };
}

export async function advanceConfirm(deps, { exec }) {
  const { eth } = deps;
  if (!exec.sepolia_tx) {
    return { ok: false, reason: "NO_SEPOLIA_TX", status: LIFECYCLE.MPC_SIGNED };
  }
  if (exec.receipt_status === "0x1") {
    return {
      ok: true,
      status: LIFECYCLE.CONFIRMED,
      sepolia_tx: exec.sepolia_tx,
      skipped: true,
    };
  }
  const receipt = await waitEthReceipt(eth, exec.sepolia_tx, {
    tries: 3,
    delayMs: 2000,
  });
  if (!receipt) {
    return {
      ok: false,
      retryable: true,
      status: LIFECYCLE.BROADCAST,
      reason: "RECEIPT_PENDING",
      sepolia_tx: exec.sepolia_tx,
    };
  }
  if (receipt.status !== "0x1") {
    return {
      ok: false,
      retryable: false,
      status: LIFECYCLE.FAILED,
      reason: "RECEIPT_REVERTED",
      receipt_status: receipt.status,
    };
  }
  return {
    ok: true,
    status: LIFECYCLE.CONFIRMED,
    sepolia_tx: exec.sepolia_tx,
    receipt_status: "0x1",
  };
}
