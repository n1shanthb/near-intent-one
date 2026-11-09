#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hexToBytes, bytesToHex } from "@noble/curves/abstract/utils";
import bs58 from "bs58";

const ev = JSON.parse(readFileSync("evidence/live/gate-b-evidence.json", "utf8"));
const sig = ev.steps.signature_from_receipts.signature_json;
const commitment = ev.steps.pending_after_sign.payload_commitment;
const derived = ev.steps.derived_public_key.result;

function nearSecpToBytes(nearKey) {
  const raw = nearKey.replace(/^secp256k1:/, "");
  return bs58.decode(raw);
}

const msg = hexToBytes(commitment);
const rCompressed = hexToBytes(sig.big_r.affine_point);
const r = rCompressed.slice(1);
const s = hexToBytes(sig.s.scalar);
const compact = new Uint8Array(64);
compact.set(r, 0);
compact.set(s, 32);
const recovery = sig.recovery_id;

const result = {
  payload_commitment: commitment,
  derived_near_key: derived,
  recovery_id: recovery,
  attempts: [],
  verified: false,
};

try {
  const recovered = secp256k1.Signature.fromCompact(compact)
    .addRecoveryBit(recovery)
    .recoverPublicKey(msg);
  const uncompressed = recovered.toRawBytes(false);
  const compressed = recovered.toRawBytes(true);
  const derivedBytes = nearSecpToBytes(derived);
  const match64 =
    derivedBytes.length === 64 &&
    bytesToHex(uncompressed.slice(1)) === bytesToHex(derivedBytes);
  const matchCompressed = bytesToHex(compressed) === bytesToHex(derivedBytes);
  result.recovered_compressed = bytesToHex(compressed);
  result.recovered_uncompressed_no_prefix = bytesToHex(uncompressed.slice(1));
  result.derived_hex = bytesToHex(derivedBytes);
  result.derived_len = derivedBytes.length;
  result.verified = match64 || matchCompressed;
  result.attempts.push({
    method: "recoverPublicKey",
    verified: result.verified,
    match64,
    matchCompressed,
  });
} catch (e) {
  result.attempts.push({ method: "recoverPublicKey", error: String(e) });
}

try {
  const derivedBytes = nearSecpToBytes(derived);
  const pubBytes =
    derivedBytes.length === 64
      ? hexToBytes("04" + bytesToHex(derivedBytes))
      : derivedBytes;
  const signature = secp256k1.Signature.fromCompact(compact);
  const ok = secp256k1.verify(signature, msg, pubBytes);
  result.attempts.push({ method: "verify_with_derived", verified: ok });
  if (ok) result.verified = true;
} catch (e) {
  result.attempts.push({ method: "verify_with_derived", error: String(e) });
}

writeFileSync("evidence/live/19-ecdsa-verify.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.verified ? 0 : 2);
