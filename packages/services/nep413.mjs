/**
 * NEP-413 helpers for NIO owner authentication.
 * Spec: https://github.com/near/NEPs/blob/master/neps/nep-0413.md
 *
 * Signature = ed25519( SHA-256( u32_le(2^31+413) || borsh(Payload) ) )
 */
import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";

export const NEP413_TAG = 2147484061; // 2^31 + 413

function borshString(s) {
  const utf8 = Buffer.from(String(s), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(utf8.length, 0);
  return Buffer.concat([len, utf8]);
}

function borshOptionString(value) {
  if (value == null || value === "") return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), borshString(value)]);
}

export function generateNep413Nonce() {
  return randomBytes(32);
}

export function parseEd25519PublicKey(publicKey) {
  const raw = String(publicKey || "");
  const body = raw.startsWith("ed25519:") ? raw.slice("ed25519:".length) : raw;
  const bytes = bs58.decode(body);
  if (bytes.length !== 32) throw new Error("invalid_ed25519_public_key");
  const normalized = raw.startsWith("ed25519:") ? raw : `ed25519:${body}`;
  return { normalized, bytes: Buffer.from(bytes) };
}

function parseSignature(signature) {
  const raw = String(signature || "");
  if (/^[0-9a-fA-F]{128}$/.test(raw)) return Buffer.from(raw, "hex");
  try {
    const b58 = bs58.decode(raw.replace(/^ed25519:/, ""));
    if (b58.length === 64) return Buffer.from(b58);
  } catch {
    /* fall through */
  }
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 64) return b64;
  throw new Error("invalid_signature_encoding");
}

function normalizeNonce(nonce) {
  if (nonce instanceof Uint8Array) {
    if (nonce.length !== 32) throw new Error("nep413_nonce_must_be_32_bytes");
    return Buffer.from(nonce);
  }
  if (typeof nonce === "string") {
    const asB64 = Buffer.from(nonce, "base64");
    if (asB64.length === 32) return asB64;
    if (/^[0-9a-fA-F]{64}$/.test(nonce)) return Buffer.from(nonce, "hex");
  }
  throw new Error("nep413_nonce_must_be_32_bytes");
}

/** Borsh-serialize NEP-413 Payload. */
export function borshNep413Payload({ message, nonce, recipient, callbackUrl }) {
  const nonce32 = normalizeNonce(nonce);
  return Buffer.concat([
    borshString(message),
    nonce32,
    borshString(recipient),
    borshOptionString(callbackUrl ?? null),
  ]);
}

export function nep413HashToSign(payload) {
  const body = borshNep413Payload(payload);
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG >>> 0, 0);
  return createHash("sha256").update(Buffer.concat([tag, body])).digest();
}

/** Alias used by tests / docs */
export const nep413SignHash = nep413HashToSign;

/** Bytes for Ledger INS_SIGN_NEP413_MESSAGE (device hashes internally). */
export function ledgerNep413ApduPayload(payload) {
  return borshNep413Payload(payload);
}

export function signNep413Detached(payload, secretKey64) {
  const hash = nep413HashToSign(payload);
  const sig = nacl.sign.detached(hash, secretKey64);
  return Buffer.from(sig).toString("base64");
}

export function verifyNep413Signature({
  message,
  nonce,
  recipient,
  callbackUrl,
  publicKey,
  signature,
}) {
  const { bytes: pk } =
    typeof publicKey === "string"
      ? parseEd25519PublicKey(publicKey)
      : { bytes: Buffer.from(publicKey) };
  const sig = parseSignature(signature);
  const hash = nep413HashToSign({
    message,
    nonce,
    recipient,
    callbackUrl,
  });
  return nacl.sign.detached.verify(hash, sig, pk);
}
