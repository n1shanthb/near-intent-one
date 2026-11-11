/**
 * NEP-413 payload helpers — aligned with packages/services/nep413.mjs.
 */
import { sha256 } from "js-sha256";

export const NEP413_TAG = 2147484061;

function borshString(s: string): Uint8Array {
  const utf8 = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + utf8.length);
  new DataView(out.buffer).setUint32(0, utf8.length, true);
  out.set(utf8, 4);
  return out;
}

function borshOptionString(value: string | null | undefined): Uint8Array {
  if (value == null || value === "") return new Uint8Array([0]);
  const inner = borshString(value);
  const out = new Uint8Array(1 + inner.length);
  out[0] = 1;
  out.set(inner, 1);
  return out;
}

export type Nep413Payload = {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string | null;
};

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function borshNep413Payload(p: Nep413Payload): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("nep413_nonce_must_be_32_bytes");
  return concatBytes([
    borshString(p.message),
    p.nonce,
    borshString(p.recipient),
    borshOptionString(p.callbackUrl ?? null),
  ]);
}

/** Bytes for Ledger INS_SIGN_NEP413_MESSAGE (device applies NEP-413 hash). */
export function ledgerNep413ApduPayload(p: Nep413Payload): Uint8Array {
  return borshNep413Payload(p);
}

export function nonceFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  if (bin.length !== 32) throw new Error("nep413_nonce_must_be_32_bytes");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/** Browser verify helper (tests / diagnostics). */
export function nep413HashToSign(p: Nep413Payload): Uint8Array {
  const body = borshNep413Payload(p);
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, NEP413_TAG >>> 0, true);
  return Uint8Array.from(sha256.array(concatBytes([tag, body])));
}
