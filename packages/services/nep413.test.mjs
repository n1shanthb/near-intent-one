import { describe, it } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  generateNep413Nonce,
  nep413SignHash,
  signNep413Detached,
  verifyNep413Signature,
  NEP413_TAG,
} from "./nep413.mjs";

describe("NEP-413", () => {
  it("verifies round-trip signature (tag + borsh + sha256 + ed25519)", () => {
    assert.equal(NEP413_TAG, 2147484061);
    const kp = nacl.sign.keyPair();
    const publicKey = `ed25519:${bs58.encode(Buffer.from(kp.publicKey))}`;
    const nonce = generateNep413Nonce();
    const payload = {
      message: "NIO owner authentication\ndomain: app.example",
      nonce,
      recipient: "app.example",
      callbackUrl: null,
    };
    const hash = nep413SignHash(payload);
    assert.equal(hash.length, 32);
    const sig = signNep413Detached(payload, kp.secretKey);
    assert.equal(
      verifyNep413Signature({
        ...payload,
        publicKey,
        signature: sig,
      }),
      true
    );
    assert.equal(
      verifyNep413Signature({
        ...payload,
        recipient: "other.example",
        publicKey,
        signature: sig,
      }),
      false
    );
  });
});
