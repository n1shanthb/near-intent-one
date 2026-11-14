/**
 * J15 — Real MPC → EIP-155 signed raw → broadcast → settle helpers.
 * Reuses Gate-K / quote-auth primitives. Never invents signatures or receipts.
 */
import { createHash, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
  serializeSignedTx,
  decodeSignedEip155Tx,
} from "../intents-codec/quote-auth.mjs";
import {
  extractMpcSigFromNearTx,
  mpcToRsV,
  recoverFromHash,
} from "../gate-k/settle.mjs";
import { openTxJournal, TX_STATE, localTxHash } from "../execution/txJournal.mjs";
import { evaluateBroadcastAttempt } from "./executorAdapter.mjs";
import { EXEC_MODE } from "./executorAdapter.mjs";

function evmAddressFromPriv(privBytes) {
  const pub = secp256k1.getPublicKey(privBytes, false);
  const hash = keccak_256(pub.slice(1));
  return "0x" + Buffer.from(hash.slice(12)).toString("hex");
}

/**
 * Assemble EIP-155 raw from a NEAR MPC request_signature outcome.
 */
export function assembleSignedEvmFromMpc({
  nearTxFull,
  nonce,
  gasPrice,
  gasLimit,
  token,
  depositAddress,
  amount,
  chainId,
  expectedMpc,
  expectedDigestHex = null,
  maxGasPrice = null,
  maxGasLimit = null,
}) {
  if (!nearTxFull) {
    return { ok: false, reason: "near_tx_required" };
  }
  if (
    nonce === undefined ||
    nonce === null ||
    gasPrice === undefined ||
    gasLimit === undefined ||
    !token ||
    !depositAddress ||
    amount === undefined ||
    chainId === undefined ||
    !expectedMpc
  ) {
    return { ok: false, reason: "locked_tx_params_required" };
  }
  if (maxGasPrice !== null && BigInt(gasPrice) > BigInt(maxGasPrice)) {
    return { ok: false, reason: "gas_price_above_ceiling" };
  }
  if (maxGasLimit !== null && BigInt(gasLimit) > BigInt(maxGasLimit)) {
    return { ok: false, reason: "gas_limit_above_ceiling" };
  }

  const extracted = extractMpcSigFromNearTx(nearTxFull);
  if (!extracted.found) {
    return { ok: false, reason: extracted.reason || "MPC_SIG_NOT_FOUND" };
  }

  const data = erc20TransferData(depositAddress, amount);
  const digestBytes = eip155UnsignedDigest({
    nonce: BigInt(nonce),
    gasPrice: BigInt(gasPrice),
    gasLimit: BigInt(gasLimit),
    to: token,
    data,
    chainId: Number(chainId),
  });
  const digest_hex = digestHex(digestBytes);
  if (
    expectedDigestHex &&
    digest_hex.toLowerCase() !== String(expectedDigestHex).toLowerCase()
  ) {
    return { ok: false, reason: "digest_recalc_mismatch", digest_hex };
  }

  let { r, s, recoveryId } = mpcToRsV(extracted.signature_json);
  let recovered = recoverFromHash(digestBytes, r, s, recoveryId);
  const mpc = String(expectedMpc).toLowerCase();
  if (recovered.toLowerCase() !== mpc) {
    const alt = recoveryId ^ 1;
    const altAddr = recoverFromHash(digestBytes, r, s, alt);
    if (altAddr.toLowerCase() === mpc) {
      recoveryId = alt;
      recovered = mpc;
    }
  }
  if (recovered.toLowerCase() !== mpc) {
    return {
      ok: false,
      reason: "recovered_address_mismatch",
      recovered: recovered.toLowerCase(),
      expected: mpc,
    };
  }

  const rawHex = serializeSignedTx({
    nonce: BigInt(nonce),
    gasPrice: BigInt(gasPrice),
    gasLimit: BigInt(gasLimit),
    to: token,
    data,
    chainId: Number(chainId),
    r,
    s,
    recoveryId,
  });

  return {
    ok: true,
    rawHex,
    digest_hex,
    recovered: mpc,
    token: String(token).toLowerCase(),
    deposit_address: String(depositAddress).toLowerCase(),
    amount: String(amount),
    nonce: Number(nonce),
    gas_price: String(gasPrice),
    gas_limit: String(gasLimit),
    chain_id: Number(chainId),
    mpc_signature: extracted.signature_json,
  };
}

/**
 * Sign EIP-155 digest with a local secp256k1 key (LOCAL_FORK / fixture only).
 * Produces the same {r,s,recoveryId} shape as NEAR MPC Secp256k1 responses.
 */
export function signEip155WithLocalKey({
  privateKeyHex,
  nonce,
  gasPrice,
  gasLimit,
  token,
  depositAddress,
  amount,
  chainId,
}) {
  const priv = Buffer.from(String(privateKeyHex).replace(/^0x/, ""), "hex");
  if (priv.length !== 32) return { ok: false, reason: "invalid_private_key" };
  const expected = evmAddressFromPriv(priv);
  const data = erc20TransferData(depositAddress, amount);
  const digestBytes = eip155UnsignedDigest({
    nonce: BigInt(nonce),
    gasPrice: BigInt(gasPrice),
    gasLimit: BigInt(gasLimit),
    to: token,
    data,
    chainId: Number(chainId),
  });
  const digest_hex = digestHex(digestBytes);
  const sig = secp256k1.sign(digestBytes, priv);
  const r = Buffer.from(sig.toCompactRawBytes().slice(0, 32));
  const s = Buffer.from(sig.toCompactRawBytes().slice(32, 64));
  const recoveryId = sig.recovery;
  const recovered = recoverFromHash(digestBytes, r, s, recoveryId);
  if (recovered.toLowerCase() !== expected.toLowerCase()) {
    return {
      ok: false,
      reason: "local_recovery_mismatch",
      recovered,
      expected,
    };
  }
  const rawHex = serializeSignedTx({
    nonce: BigInt(nonce),
    gasPrice: BigInt(gasPrice),
    gasLimit: BigInt(gasLimit),
    to: token,
    data,
    chainId: Number(chainId),
    r,
    s,
    recoveryId,
  });
  // MPC-shaped JSON for pipeline parity tests
  const uncompressed = secp256k1.getPublicKey(priv, false);
  // affine point for big_r is not identical to MPC format; callers using assemble
  // from MPC need real Near receipts. This helper returns ready rawHex.
  return {
    ok: true,
    rawHex,
    digest_hex,
    recovered: expected.toLowerCase(),
    r,
    s,
    recoveryId,
    token: String(token).toLowerCase(),
    deposit_address: String(depositAddress).toLowerCase(),
    amount: String(amount),
    nonce: Number(nonce),
    gas_price: String(gasPrice),
    gas_limit: String(gasLimit),
    chain_id: Number(chainId),
    label: "LOCAL_KEY_NOT_NEAR_MPC",
    pubkey_uncompressed_hex: Buffer.from(uncompressed).toString("hex"),
  };
}

export function validateSignedRawAgainstPolicy({
  signedRawHex,
  expected,
}) {
  const decoded = decodeSignedEip155Tx(signedRawHex, {
    recoverFn: recoverFromHash,
  });
  if (!decoded.ok) return decoded;
  const blockers = [];
  if (
    expected.chainId !== undefined &&
    Number(decoded.chainId) !== Number(expected.chainId)
  ) {
    blockers.push("chain_id_mismatch");
  }
  if (
    expected.nonce !== undefined &&
    Number(decoded.nonce) !== Number(expected.nonce)
  ) {
    blockers.push("nonce_mismatch");
  }
  if (
    expected.token &&
    String(decoded.to).toLowerCase() !== String(expected.token).toLowerCase()
  ) {
    blockers.push("token_mismatch");
  }
  if (
    expected.mpc &&
    String(decoded.recovered || "").toLowerCase() !==
      String(expected.mpc).toLowerCase()
  ) {
    blockers.push("sender_mismatch");
  }
  if (expected.depositAddress && decoded.transfer) {
    if (
      decoded.transfer.recipient.toLowerCase() !==
      String(expected.depositAddress).toLowerCase()
    ) {
      blockers.push("destination_mismatch");
    }
  }
  if (expected.amount !== undefined && decoded.transfer) {
    if (String(decoded.transfer.amount) !== String(expected.amount)) {
      blockers.push("amount_mismatch");
    }
  }
  if (
    expected.maxGasPrice !== undefined &&
    BigInt(decoded.gasPrice) > BigInt(expected.maxGasPrice)
  ) {
    blockers.push("gas_price_ceiling");
  }
  if (
    expected.digestHex &&
    decoded.digest_hex.toLowerCase() !== String(expected.digestHex).toLowerCase()
  ) {
    blockers.push("digest_mismatch");
  }
  return {
    ok: blockers.length === 0,
    blockers,
    decoded,
  };
}

/**
 * Minimal realistic local EVM JSON-RPC for settlement-path proofs.
 * Labeled LOCAL_FORK — not mainnet.
 */
export function createLocalForkRpc({
  chainId = 31337,
  signerAddress,
  startNonce = 0,
} = {}) {
  const state = {
    chainId: Number(chainId),
    nonces: new Map(),
    txs: new Map(),
    receipts: new Map(),
    seenRaw: new Set(),
    blockNumber: 1,
    label: "LOCAL_FORK",
  };
  if (signerAddress) {
    state.nonces.set(String(signerAddress).toLowerCase(), Number(startNonce));
  }

  async function eth(method, params = []) {
    switch (method) {
      case "eth_chainId":
        return { result: "0x" + state.chainId.toString(16) };
      case "eth_blockNumber":
        return { result: "0x" + state.blockNumber.toString(16) };
      case "eth_getTransactionCount": {
        const addr = String(params[0] || "").toLowerCase();
        const n = state.nonces.get(addr) || 0;
        return { result: "0x" + n.toString(16) };
      }
      case "eth_sendRawTransaction": {
        const raw = String(params[0] || "").toLowerCase();
        if (!raw.startsWith("0x")) {
          return { error: { message: "invalid raw tx" } };
        }
        if (state.seenRaw.has(raw)) {
          return { error: { message: "nonce too low / replay" } };
        }
        const decoded = decodeSignedEip155Tx(raw, {
          recoverFn: recoverFromHash,
        });
        if (!decoded.ok) {
          return { error: { message: decoded.reason } };
        }
        if (Number(decoded.chainId) !== state.chainId) {
          return { error: { message: "wrong chain id" } };
        }
        const sender = String(decoded.recovered || "").toLowerCase();
        const expectedNonce = state.nonces.get(sender) || 0;
        if (Number(decoded.nonce) !== expectedNonce) {
          return {
            error: {
              message: `nonce mismatch got=${decoded.nonce} want=${expectedNonce}`,
            },
          };
        }
        const txHash =
          "0x" +
          createHash("sha256").update(Buffer.from(raw.slice(2), "hex")).digest("hex");
        state.seenRaw.add(raw);
        state.nonces.set(sender, expectedNonce + 1);
        state.blockNumber += 1;
        const receipt = {
          transactionHash: txHash,
          status: "0x1",
          blockNumber: "0x" + state.blockNumber.toString(16),
          from: sender,
          to: decoded.to,
          logs: decoded.transfer
            ? [
                {
                  address: decoded.to,
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x" + sender.replace(/^0x/, "").padStart(64, "0"),
                    "0x" +
                      decoded.transfer.recipient
                        .replace(/^0x/, "")
                        .padStart(64, "0"),
                  ],
                  data:
                    "0x" +
                    BigInt(decoded.transfer.amount).toString(16).padStart(64, "0"),
                },
              ]
            : [],
          independently_verified: true,
          label: "LOCAL_FORK",
        };
        state.txs.set(txHash, { raw, decoded, sender });
        state.receipts.set(txHash, receipt);
        return { result: txHash };
      }
      case "eth_getTransactionReceipt": {
        const hash = String(params[0] || "").toLowerCase();
        return { result: state.receipts.get(hash) || null };
      }
      default:
        return { error: { message: `unsupported:${method}` } };
    }
  }

  return { eth, state, label: "LOCAL_FORK" };
}

export async function broadcastSignedRawOnce({
  eth,
  signedRawHex,
  journal,
  journalId,
  priorState = TX_STATE.SIGNED,
}) {
  if (!eth) return { ok: false, reason: "eth_rpc_required" };
  if (!signedRawHex || !String(signedRawHex).startsWith("0x")) {
    return { ok: false, reason: "signed_raw_hex_required" };
  }
  if (journal && journalId) {
    const rec = typeof journal.get === "function" ? journal.get(journalId) : null;
    if (rec && (rec.state === TX_STATE.BROADCAST || rec.state === TX_STATE.CONFIRMED)) {
      return {
        ok: false,
        reason: "already_broadcast",
        action: "REFUSE_RETRY",
        may_resign: false,
      };
    }
    if (typeof journal.beginBroadcast === "function") {
      try {
        journal.beginBroadcast(journalId);
      } catch (e) {
        // tolerate missing draft transition helpers in slim journals
        if (!/invalid_transition|unknown_journal/.test(String(e.message || e))) {
          return { ok: false, reason: String(e.message || e) };
        }
      }
    }
  }

  let rpcResult;
  let transportError = null;
  try {
    const j = await eth("eth_sendRawTransaction", [signedRawHex]);
    if (j?.error) {
      transportError = j.error.message || JSON.stringify(j.error);
    } else {
      rpcResult = { tx_hash: j.result };
    }
  } catch (e) {
    transportError = String(e.message || e);
  }

  const evalr = evaluateBroadcastAttempt({
    priorState,
    rpcResult,
    transportError,
  });
  if (evalr.ok && journal && journalId && typeof journal.markBroadcast === "function") {
    journal.markBroadcast(journalId, evalr.tx_hash);
  }
  return {
    ...evalr,
    rpcResult,
    transportError,
    local_tx_hash: localTxHash(signedRawHex),
  };
}

/**
 * Independent settlement check against receipt + expected transfer.
 * Never invents success without receipt evidence.
 */
export function verifySettlementFromReceipt({
  receipt,
  expected,
  allowLocalForkLabel = false,
}) {
  if (!receipt) {
    return { ok: false, reason: "receipt_missing", unknown: true };
  }
  if (receipt.status !== "0x1" && receipt.status !== 1 && receipt.status !== "1") {
    return { ok: false, reason: "receipt_failed_status", receipt };
  }
  if (receipt.label === "LOCAL_FORK" && !allowLocalForkLabel) {
    return {
      ok: false,
      reason: "local_fork_receipt_not_accepted_as_mainnet",
      label: "LOCAL_FORK",
    };
  }
  const from = String(receipt.from || "").toLowerCase();
  if (expected.mpc && from !== String(expected.mpc).toLowerCase()) {
    return { ok: false, reason: "receipt_from_mismatch", from };
  }
  if (expected.token) {
    const to = String(receipt.to || "").toLowerCase();
    if (to !== String(expected.token).toLowerCase()) {
      return { ok: false, reason: "receipt_token_mismatch", to };
    }
  }
  // ERC-20 Transfer topic0
  const transferTopic =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const hit = logs.find(
    (l) => String(l.topics?.[0] || "").toLowerCase() === transferTopic
  );
  if (!hit) {
    return { ok: false, reason: "transfer_log_missing" };
  }
  if (expected.depositAddress) {
    const toTopic = String(hit.topics?.[2] || "").toLowerCase();
    const want =
      "0x" +
      String(expected.depositAddress)
        .replace(/^0x/, "")
        .toLowerCase()
        .padStart(64, "0");
    if (toTopic !== want) {
      return { ok: false, reason: "transfer_destination_mismatch" };
    }
  }
  if (expected.amount !== undefined) {
    const amt = BigInt(hit.data || "0x0").toString();
    if (amt !== String(expected.amount)) {
      return { ok: false, reason: "transfer_amount_mismatch", amt };
    }
  }
  return {
    ok: true,
    status: "SETTLED",
    tx_hash: receipt.transactionHash,
    independently_verified: true,
    label: receipt.label || "LIVE",
  };
}

export function generateLocalForkSigner() {
  const priv = randomBytes(32);
  const address = evmAddressFromPriv(priv);
  return {
    privateKeyHex: "0x" + priv.toString("hex"),
    address,
    label: "LOCAL_FORK_EPHEMERAL_KEY",
  };
}

export { recoverFromHash, extractMpcSigFromNearTx, mpcToRsV, localTxHash, TX_STATE, openTxJournal, EXEC_MODE };
