/**
 * EIP-191 / ERC-191 helpers for NEAR Intents payloads.
 * Digest = keccak256("\x19Ethereum Signed Message:\n" + len(msg) + msg)
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/curves/abstract/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import bs58 from "bs58";

export function eip191Prehash(payloadString) {
  const msg = Buffer.from(payloadString, "utf8");
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`, "utf8");
  return keccak_256(Buffer.concat([prefix, msg]));
}

export function eip191DigestHex(payloadString) {
  return bytesToHex(eip191Prehash(payloadString));
}

/** Uncompressed 64-byte (x||y) or 65-byte (0x04||x||y) → 0x-prefixed lowercase address */
export function evmAddressFromPubkey(pubkeyBytes) {
  let raw = Uint8Array.from(pubkeyBytes);
  if (raw.length === 65 && raw[0] === 0x04) raw = raw.slice(1);
  if (raw.length !== 64) throw new Error(`expected 64-byte uncompressed pubkey, got ${raw.length}`);
  const hash = keccak_256(raw);
  return "0x" + bytesToHex(hash.slice(12));
}

export function nearSecpKeyToBytes(nearKey) {
  return bs58.decode(nearKey.replace(/^secp256k1:/, ""));
}

export function evmAddressFromNearSecpKey(nearKey) {
  return evmAddressFromPubkey(nearSecpKeyToBytes(nearKey));
}

/**
 * Convert MPC Secp256k1 response → intents `secp256k1:<base58(r||s||v)>` with v∈{0,1}.
 */
export function mpcSigToIntentsEncoding(sig) {
  const rPoint = hexToBytes(sig.big_r.affine_point);
  const r = rPoint.slice(1); // 32-byte x
  const s = hexToBytes(sig.s.scalar);
  let v = Number(sig.recovery_id);
  if (v === 27 || v === 28) v -= 27;
  if (v !== 0 && v !== 1) throw new Error(`recovery_id must be 0/1 (or 27/28), got ${sig.recovery_id}`);
  const packed = new Uint8Array(65);
  packed.set(r, 0);
  packed.set(s, 32);
  packed[64] = v;
  return `secp256k1:${bs58.encode(packed)}`;
}

export function recoverAddressFromErc191(payloadString, intentsSig) {
  const raw = bs58.decode(intentsSig.replace(/^secp256k1:/, ""));
  if (raw.length !== 65) throw new Error(`expected 65-byte sig, got ${raw.length}`);
  const compact = raw.slice(0, 64);
  const recovery = raw[64];
  const digest = eip191Prehash(payloadString);
  const recovered = secp256k1.Signature.fromCompact(compact)
    .addRecoveryBit(recovery)
    .recoverPublicKey(digest);
  return evmAddressFromPubkey(recovered.toRawBytes(false));
}

/** Deterministic JSON for intents: no spaces; key order as constructed. */
export function buildIntentPayloadObject({
  signerId,
  verifyingContract,
  deadlineIso,
  nonceBase64,
  intents,
}) {
  return {
    signer_id: signerId.toLowerCase(),
    verifying_contract: verifyingContract,
    deadline: deadlineIso,
    nonce: nonceBase64,
    intents,
  };
}

export function serializeIntentPayload(obj) {
  // Exact bytes matter. Use compact JSON with fixed key order.
  return JSON.stringify(obj);
}
