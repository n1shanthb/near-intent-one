import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  createOwnerAuth,
  openOwnerAuthStore,
  verifySessionToken,
} from "./ownerAuth.mjs";
import { signNep413Detached } from "./nep413.mjs";

function tempAuth(listAccessKeys) {
  const dir = mkdtempSync(join(tmpdir(), "nio-owner-auth-"));
  const kp = nacl.sign.keyPair();
  const publicKey = `ed25519:${bs58.encode(Buffer.from(kp.publicKey))}`;
  const auth = createOwnerAuth({
    store: openOwnerAuthStore(dir),
    secret: "test-owner-auth-secret-32b",
    network: "testnet",
    listAccessKeys:
      listAccessKeys ||
      (async () => [{ public_key: publicKey, permission: "FullAccess" }]),
    challengeTtlMs: 60_000,
    sessionTtlMs: 120_000,
  });
  return { dir, auth, kp, publicKey };
}

function signChallenge(ch, kp) {
  return signNep413Detached(
    {
      message: ch.message,
      nonce: Buffer.from(ch.nonce, "base64"),
      recipient: ch.recipient,
      callbackUrl: ch.callback_url,
    },
    kp.secretKey
  );
}

describe("owner auth NEP-413 challenge/session", () => {
  it("issues NEP-413 domain-bound challenge", () => {
    const { dir, auth } = tempAuth();
    try {
      const out = auth.issueChallenge({
        account_id: "alice.testnet",
        domain: "near-intent-one.vercel.app",
      });
      assert.equal(out.ok, true);
      assert.equal(out.challenge.scheme, "nep413");
      assert.equal(out.challenge.recipient, "near-intent-one.vercel.app");
      assert.match(out.challenge.message, /account: alice\.testnet/);
      assert.ok(out.challenge.nonce);
      assert.equal(Buffer.from(out.challenge.nonce, "base64").length, 32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies good NEP-413 signature and rejects account mismatch", async () => {
    const { dir, auth, kp, publicKey } = tempAuth();
    try {
      const ch = auth.issueChallenge({
        account_id: "alice.testnet",
        domain: "near-intent-one.vercel.app",
      }).challenge;
      const sig = signChallenge(ch, kp);
      const bad = await auth.verifyChallenge({
        challenge_id: ch.challenge_id,
        account_id: "eve.testnet",
        public_key: publicKey,
        signature: sig,
        domain: "near-intent-one.vercel.app",
      });
      assert.equal(bad.ok, false);
      assert.equal(bad.reason, "account_mismatch");

      const ch2 = auth.issueChallenge({
        account_id: "alice.testnet",
        domain: "near-intent-one.vercel.app",
      }).challenge;
      const ok = await auth.verifyChallenge({
        challenge_id: ch2.challenge_id,
        account_id: "alice.testnet",
        public_key: publicKey,
        signature: signChallenge(ch2, kp),
        domain: "near-intent-one.vercel.app",
      });
      assert.equal(ok.ok, true);
      assert.equal(ok.session.scheme, "nep413");
      assert.ok(ok.session.token.startsWith("nio1."));
      assert.equal(
        verifySessionToken(ok.session.token, "test-owner-auth-secret-32b").ok,
        true
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects expired, replay, domain mismatch, non-FullAccess", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nio-owner-auth-"));
    try {
      const kp = nacl.sign.keyPair();
      const publicKey = `ed25519:${bs58.encode(Buffer.from(kp.publicKey))}`;
      const store = openOwnerAuthStore(dir);
      const auth = createOwnerAuth({
        store,
        secret: "test-owner-auth-secret-32b",
        network: "testnet",
        listAccessKeys: async () => [
          { public_key: publicKey, permission: "FullAccess" },
        ],
        challengeTtlMs: 60_000,
      });
      const ch = auth.issueChallenge({
        account_id: "alice.testnet",
        domain: "example.com",
      }).challenge;
      // Force expiry without relying on 1ms TTL races / prune deleting the row.
      store.update((s) => {
        if (s.challenges[ch.challenge_id]) {
          s.challenges[ch.challenge_id].expires_at = new Date(
            Date.now() - 60_000
          ).toISOString();
        }
        return s;
      });
      const expired = await auth.verifyChallenge({
        challenge_id: ch.challenge_id,
        account_id: "alice.testnet",
        public_key: publicKey,
        signature: signChallenge(ch, kp),
      });
      assert.equal(expired.reason, "challenge_expired");

      const auth2 = createOwnerAuth({
        store: openOwnerAuthStore(dir),
        secret: "test-owner-auth-secret-32b",
        network: "testnet",
        listAccessKeys: async () => [
          { public_key: publicKey, permission: "FullAccess" },
        ],
      });
      const ch2 = auth2.issueChallenge({
        account_id: "alice.testnet",
        domain: "example.com",
      }).challenge;
      const first = await auth2.verifyChallenge({
        challenge_id: ch2.challenge_id,
        account_id: "alice.testnet",
        public_key: publicKey,
        signature: signChallenge(ch2, kp),
      });
      assert.equal(first.ok, true);
      const replay = await auth2.verifyChallenge({
        challenge_id: ch2.challenge_id,
        account_id: "alice.testnet",
        public_key: publicKey,
        signature: signChallenge(ch2, kp),
      });
      assert.equal(replay.reason, "challenge_replay");

      const ch3 = auth2.issueChallenge({
        account_id: "alice.testnet",
        domain: "example.com",
      }).challenge;
      const dom = await auth2.verifyChallenge({
        challenge_id: ch3.challenge_id,
        account_id: "alice.testnet",
        public_key: publicKey,
        signature: signChallenge(ch3, kp),
        domain: "evil.example",
      });
      assert.equal(dom.reason, "domain_mismatch");

      const authFa = createOwnerAuth({
        store: openOwnerAuthStore(dir),
        secret: "test-owner-auth-secret-32b",
        network: "testnet",
        listAccessKeys: async () => [
          {
            public_key: publicKey,
            permission: { FunctionCall: { receiver_id: "x" } },
          },
        ],
      });
      const ch4 = authFa.issueChallenge({
        account_id: "alice.testnet",
        domain: "example.com",
      }).challenge;
      const fa = await authFa.verifyChallenge({
        challenge_id: ch4.challenge_id,
        account_id: "alice.testnet",
        public_key: publicKey,
        signature: signChallenge(ch4, kp),
      });
      assert.equal(fa.reason, "full_access_key_required");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
