/**
 * Quote attestation V2 + EIP-155 helpers (Gate F1+).
 * Must stay aligned with contracts/policy/src/evm_auth.rs.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/curves/abstract/utils";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  quoteHash as oneClickQuoteHash,
} from "@defuse-protocol/one-click-sdk-typescript";
import { verifySignedOneClickQuote } from "./oneClickVerify.mjs";

export function attestationMessageV2({
  depositAddress,
  amountIn,
  assetIn,
  assetOut,
  minAmountOut,
  quoteDeadlineNs,
  tokenContract,
  chainId,
  recipient,
  refundTo,
  correlationId,
  quoteHash,
  maxGasPrice,
  gasLimit,
}) {
  return Buffer.from(
    `QUOTE_AUTH_V2\ndeposit=${depositAddress.toLowerCase()}\namount_in=${amountIn}\nasset_in=${assetIn}\nasset_out=${assetOut}\nmin_out=${minAmountOut}\ndeadline_ns=${quoteDeadlineNs}\ntoken=${tokenContract.toLowerCase()}\nchain_id=${chainId}\nrecipient=${recipient.toLowerCase()}\nrefund_to=${refundTo.toLowerCase()}\ncorrelation_id=${correlationId}\nquote_hash=${quoteHash}\nmax_gas_price=${maxGasPrice}\ngas_limit=${gasLimit}\n`,
    "utf8"
  );
}

/** @deprecated Gate E V1 — kept for evidence continuity only */
export function attestationMessage(args) {
  return Buffer.from(
    `QUOTE_AUTH_V1\ndeposit=${args.depositAddress.toLowerCase()}\namount_in=${args.amountIn}\nasset_in=${args.assetIn}\nasset_out=${args.assetOut}\nmin_out=${args.minAmountOut}\ndeadline_ns=${args.quoteDeadlineNs}\ntoken=${args.tokenContract.toLowerCase()}\nchain_id=${args.chainId}\n`,
    "utf8"
  );
}

export function signAttestation(messageBytes, secretKey64) {
  const sig = nacl.sign.detached(messageBytes, secretKey64);
  return `ed25519:${bs58.encode(sig)}`;
}

export function publicKeyEd25519(secretKey64) {
  const kp = nacl.sign.keyPair.fromSecretKey(secretKey64);
  return `ed25519:${bs58.encode(kp.publicKey)}`;
}

export function attestationId(messageBytes) {
  return bytesToHex(sha256(messageBytes));
}

/**
 * Independent attestor: validates Tidepool quote against agent request BEFORE signing.
 * Refuses arbitrary destinations that are not the quote's depositAddress.
 */
export function attestTidepoolQuote({
  quoteResponse,
  agentRequest,
  tokenContract,
  chainId,
  maxGasPrice,
  gasLimit,
  secretKey64,
  tidepoolManagerPubKey = null,
  /**
   * J5 default: refuse to attest unless official 1Click signature verifies.
   * Legacy Gate F may pass allowUnverifiedOneClick=true explicitly (not for mainnet funded).
   */
  allowUnverifiedOneClick = false,
  maxAgeMs,
  nowMs,
}) {
  const checks = [];
  const fail = (reason) => {
    checks.push({ ok: false, reason });
    return { ok: false, checks, attestation: null, signature: null, publicKey: null };
  };

  if (!quoteResponse?.quote?.depositAddress) {
    return fail("missing depositAddress");
  }
  if (!quoteResponse.correlationId) return fail("missing correlationId");
  if (!quoteResponse.signature) return fail("missing quote signature field");

  const q = quoteResponse.quote;
  const qr = quoteResponse.quoteRequest || {};

  // Structural bind to agent request
  const expect = [
    ["originAsset", agentRequest.originAsset, qr.originAsset],
    ["destinationAsset", agentRequest.destinationAsset, qr.destinationAsset],
    ["amount", agentRequest.amount, qr.amount || q.amountIn],
    ["depositType", agentRequest.depositType, qr.depositType],
    ["recipient", agentRequest.recipient?.toLowerCase(), qr.recipient?.toLowerCase()],
    ["refundTo", agentRequest.refundTo?.toLowerCase(), qr.refundTo?.toLowerCase()],
  ];
  for (const [name, want, got] of expect) {
    if (want && got && String(want) !== String(got)) {
      return fail(`quote field mismatch ${name}: want=${want} got=${got}`);
    }
    checks.push({ ok: true, check: name, value: got });
  }

  // Critical: deposit must come from quote, never agent-supplied alternate
  if (
    agentRequest.requestedDeposit &&
    agentRequest.requestedDeposit.toLowerCase() !== q.depositAddress.toLowerCase()
  ) {
    return fail("agent requestedDeposit != quote.depositAddress — refusing to attest");
  }
  checks.push({
    ok: true,
    check: "deposit_from_quote_only",
    depositAddress: q.depositAddress,
  });

  // Official 1Click signature MUST verify before we generate our attestation (J5).
  const oneClick = verifySignedOneClickQuote(quoteResponse, {
    agentRequest,
    managerPublicKey: tidepoolManagerPubKey || undefined,
    maxAgeMs,
    nowMs,
    forbidLlmDeposit: true,
    llmDepositAddress: agentRequest?.requestedDeposit || null,
  });
  checks.push({
    ok: oneClick.ok,
    check: "one_click_signature_verify",
    verified: oneClick.verified,
    reason: oneClick.reason || null,
    quote_hash: oneClick.quote_hash || null,
  });
  if (!oneClick.ok && !allowUnverifiedOneClick) {
    return fail(`one_click_verify_failed:${oneClick.reason}`);
  }
  if (!oneClick.ok && allowUnverifiedOneClick) {
    checks.push({
      ok: true,
      check: "allow_unverified_legacy_escape",
      note: "explicit allowUnverifiedOneClick — not safe for mainnet funded path",
    });
  }

  const qh = oneClick.quote_hash || oneClickQuoteHash(quoteResponse);
  const deadlineIso = q.deadline || agentRequest.deadline;
  const quoteDeadlineNs = String(BigInt(Date.parse(deadlineIso)) * 1_000_000n);

  const attestation = {
    deposit_address: q.depositAddress.toLowerCase(),
    amount_in: q.amountIn,
    asset_in: agentRequest.originAsset,
    asset_out: agentRequest.destinationAsset,
    min_amount_out: q.minAmountOut,
    quote_deadline_ns: quoteDeadlineNs,
    token_contract: tokenContract.toLowerCase(),
    chain_id: String(chainId),
    recipient: (qr.recipient || agentRequest.recipient).toLowerCase(),
    refund_to: (qr.refundTo || agentRequest.refundTo).toLowerCase(),
    correlation_id: quoteResponse.correlationId,
    quote_hash: qh,
    max_gas_price: String(maxGasPrice),
    gas_limit: String(gasLimit),
  };

  const msg = attestationMessageV2({
    depositAddress: attestation.deposit_address,
    amountIn: attestation.amount_in,
    assetIn: attestation.asset_in,
    assetOut: attestation.asset_out,
    minAmountOut: attestation.min_amount_out,
    quoteDeadlineNs: attestation.quote_deadline_ns,
    tokenContract: attestation.token_contract,
    chainId: attestation.chain_id,
    recipient: attestation.recipient,
    refundTo: attestation.refund_to,
    correlationId: attestation.correlation_id,
    quoteHash: attestation.quote_hash,
    maxGasPrice: attestation.max_gas_price,
    gasLimit: attestation.gas_limit,
  });
  const signature = signAttestation(msg, secretKey64);
  const publicKey = publicKeyEd25519(secretKey64);

  return {
    ok: true,
    checks,
    oneClickVerify: oneClick,
    tidepoolVerify: {
      status: oneClick.ok ? "PASS" : "BLOCKED",
      verified: oneClick.verified,
      reason: oneClick.reason || null,
    },
    attestation,
    signature,
    publicKey,
    message_utf8: msg.toString("utf8"),
    attestation_id: attestationId(msg),
    trust_model: oneClick.ok
      ? "one_click_verified_then_trusted_attestor"
      : "trusted_attestor_not_tidepool_maker",
  };
}

function bigIntToMinimalBytes(n) {
  if (n === 0n) return Buffer.alloc(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}

export function rlpEncode(item) {
  if (item instanceof Uint8Array || Buffer.isBuffer(item)) {
    const buf = Buffer.from(item);
    if (buf.length === 1 && buf[0] < 0x80) return buf;
    if (buf.length <= 55) {
      return Buffer.concat([Buffer.from([0x80 + buf.length]), buf]);
    }
    const lenBuf = bigIntToMinimalBytes(BigInt(buf.length));
    return Buffer.concat([Buffer.from([0xb7 + lenBuf.length]), lenBuf, buf]);
  }
  if (Array.isArray(item)) {
    const encoded = Buffer.concat(item.map(rlpEncode));
    if (encoded.length <= 55) {
      return Buffer.concat([Buffer.from([0xc0 + encoded.length]), encoded]);
    }
    const lenBuf = bigIntToMinimalBytes(BigInt(encoded.length));
    return Buffer.concat([Buffer.from([0xf7 + lenBuf.length]), lenBuf, encoded]);
  }
  throw new Error("rlp: unsupported");
}

export function encodeQuantity(n) {
  return bigIntToMinimalBytes(typeof n === "bigint" ? n : BigInt(n));
}

export function erc20TransferData(to, amount) {
  const sel = Buffer.from("a9059cbb", "hex");
  const addr = Buffer.from(to.replace(/^0x/, "").toLowerCase().padStart(64, "0"), "hex");
  const amt = Buffer.from(BigInt(amount).toString(16).padStart(64, "0"), "hex");
  return Buffer.concat([sel, addr, amt]);
}

export function eip155UnsignedDigest({
  nonce,
  gasPrice,
  gasLimit,
  to,
  value = 0n,
  data,
  chainId,
}) {
  const payload = rlpEncode([
    encodeQuantity(nonce),
    encodeQuantity(gasPrice),
    encodeQuantity(gasLimit),
    Buffer.from(to.replace(/^0x/, ""), "hex"),
    encodeQuantity(value),
    data,
    encodeQuantity(chainId),
    Buffer.alloc(0),
    Buffer.alloc(0),
  ]);
  return keccak_256(payload);
}

export function digestHex(digest) {
  return bytesToHex(digest);
}

export function serializeSignedTx({
  nonce,
  gasPrice,
  gasLimit,
  to,
  value = 0n,
  data = Buffer.alloc(0),
  chainId,
  r,
  s,
  recoveryId,
}) {
  const v = BigInt(chainId) * 2n + 35n + BigInt(recoveryId);
  const raw = rlpEncode([
    encodeQuantity(nonce),
    encodeQuantity(gasPrice),
    encodeQuantity(gasLimit),
    Buffer.from(to.replace(/^0x/, ""), "hex"),
    encodeQuantity(value),
    data,
    encodeQuantity(v),
    Buffer.from(r),
    Buffer.from(s),
  ]);
  return "0x" + Buffer.from(raw).toString("hex");
}
