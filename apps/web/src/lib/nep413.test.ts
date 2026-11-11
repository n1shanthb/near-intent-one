import { describe, expect, it } from "vitest";
import {
  NEP413_TAG,
  borshNep413Payload,
  bytesToBase64,
  ledgerNep413ApduPayload,
  nep413HashToSign,
  nonceFromBase64,
} from "./nep413";

describe("nep413 browser helpers", () => {
  it("requires 32-byte nonce", () => {
    expect(() =>
      borshNep413Payload({
        message: "hi",
        nonce: new Uint8Array(31),
        recipient: "example.com",
      })
    ).toThrow(/32/);
  });

  it("borsh + hash are deterministic for fixed inputs", () => {
    const nonce = new Uint8Array(32);
    nonce[0] = 7;
    const payload = {
      message: "NIO owner authentication\ndomain: t\naccount: a.testnet",
      nonce,
      recipient: "near-intent-one.vercel.app",
      callbackUrl: null as string | null,
    };
    const body = borshNep413Payload(payload);
    const apdu = ledgerNep413ApduPayload(payload);
    expect(apdu).toEqual(body);
    expect(body.byteLength).toBeGreaterThan(40);

    const h1 = nep413HashToSign(payload);
    const h2 = nep413HashToSign(payload);
    expect(h1).toEqual(h2);
    expect(h1.length).toBe(32);
    expect(NEP413_TAG).toBe(2147484061);
  });

  it("round-trips base64 nonce", () => {
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw[i] = i;
    const b64 = bytesToBase64(raw);
    expect(nonceFromBase64(b64)).toEqual(raw);
  });
});
