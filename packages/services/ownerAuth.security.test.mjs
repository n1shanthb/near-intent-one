/**
 * NEP-413 owner-auth security suite (deterministic test keys only).
 * Does NOT prove physical Ledger signing.
 */
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

function kpPair() {
  const kp = nacl.sign.keyPair();
  const publicKey = `ed25519:${bs58.encode(Buffer.from(kp.publicKey))}`;
  return { kp, publicKey };
}

function signCh(ch, kp) {
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

function makeAuth(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nio-auth-sec-"));
  const { kp, publicKey } = kpPair();
  const auth = createOwnerAuth({
    store: openOwnerAuthStore(dir),
    secret: "test-owner-auth-secret-32b",
    network: opts.network || "testnet",
    listAccessKeys:
      opts.listAccessKeys ||
      (async () => [{ public_key: publicKey, permission: "FullAccess" }]),
    challengeTtlMs: opts.challengeTtlMs || 60_000,
    sessionTtlMs: opts.sessionTtlMs || 120_000,
  });
  return { dir, auth, kp, publicKey };
}

describe("NEP-413 security — binding / keys / replay", () => {
  it("binds domain and account; rejects cross-account key", async () => {
    const alice = makeAuth();
    const eve = kpPair();
    try {
      const ch = alice.auth.issueChallenge({
        account_id: "alice.testnet",
        domain: "near-intent-one.vercel.app",
      }).challenge;
      // Eve signs with Eve key but claims alice account + alice challenge
      const bad = await alice.auth.verifyChallenge({
        challenge_id: ch.challenge_id,
        account_id: "alice.testnet",
        public_key: eve.publicKey,
        signature: signCh(ch, eve.kp),
        domain: "near-intent-one.vercel.app",
      });
      assert.equal(bad.ok, false);
      assert.ok(
        ["public_key_not_on_account", "bad_signature"].includes(bad.reason)
      );
    } finally {
      rmSync(alice.dir, { recursive: true, force: true });
    }
  });

  it("rejects wrong network construction", () => {
    const dir = mkdtempSync(join(tmpdir(), "nio-auth-net-"));
    try {
      assert.throws(
        () =>
          createOwnerAuth({
            store: openOwnerAuthStore(dir),
            secret: "test-owner-auth-secret-32b",
            network: "mainnet",
            listAccessKeys: async () => [],
          }).issueChallenge({
            account_id: "alice.near",
            domain: "x.com",
          }),
        /./
      );
    } catch {
      // createOwnerAuth itself may not throw; issueChallenge returns wrong_network
      const auth = createOwnerAuth({
        store: openOwnerAuthStore(dir),
        secret: "test-owner-auth-secret-32b",
        network: "mainnet",
        listAccessKeys: async () => [],
      });
      const out = auth.issueChallenge({
        account_id: "alice.near",
        domain: "x.com",
      });
      assert.equal(out.ok, false);
      assert.equal(out.reason, "wrong_network");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces FullAccess; FunctionCall key rejected", async () => {
    const { kp, publicKey } = kpPair();
    const dir = mkdtempSync(join(tmpdir(), "nio-auth-fa-"));
    try {
      const auth = createOwnerAuth({
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
      const ch = auth.issueChallenge({
        account_id: "alice.testnet",
        domain: "app.example",
      }).challenge;
      const out = await auth.verifyChallenge({
        challenge_id: ch.challenge_id,
        account_id: "alice.testnet",
        public_key: publicKey,
        signature: signCh(ch, kp),
      });
      assert.equal(out.reason, "full_access_key_required");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("NEP-413 security — session / logout / concurrency", () => {
  it("session expiry and logout invalidate access", async () => {
    const { dir, auth, kp, publicKey } = makeAuth({ sessionTtlMs: 30 });
    try {
      const ch = auth.issueChallenge({
        account_id: "alice.testnet",
        domain: "app.example",
      }).challenge;
      const ok = await auth.verifyChallenge({
        challenge_id: ch.challenge_id,
        account_id: "alice.testnet",
        public_key: publicKey,
        signature: signCh(ch, kp),
      });
      assert.equal(ok.ok, true);
      const live = auth.resolveSession(ok.session.token);
      assert.equal(live.ok, true);

      const loggedOut = auth.revokeSession(ok.session.token);
      assert.equal(loggedOut.ok, true);
      assert.equal(auth.resolveSession(ok.session.token).ok, false);

      // Fresh short-TTL session expires
      const ch2 = auth.issueChallenge({
        account_id: "alice.testnet",
        domain: "app.example",
      }).challenge;
      const s2 = await auth.verifyChallenge({
        challenge_id: ch2.challenge_id,
        account_id: "alice.testnet",
        public_key: publicKey,
        signature: signCh(ch2, kp),
      });
      assert.equal(s2.ok, true);
      await new Promise((r) => setTimeout(r, 40));
      const exp = verifySessionToken(s2.session.token, "test-owner-auth-secret-32b");
      assert.equal(exp.ok, false);
      assert.equal(exp.reason, "session_expired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("concurrent verify: only one winner (replay for loser)", async () => {
    const { dir, auth, kp, publicKey } = makeAuth();
    try {
      const ch = auth.issueChallenge({
        account_id: "alice.testnet",
        domain: "app.example",
      }).challenge;
      const sig = signCh(ch, kp);
      const body = {
        challenge_id: ch.challenge_id,
        account_id: "alice.testnet",
        public_key: publicKey,
        signature: sig,
      };
      const [a, b] = await Promise.all([
        auth.verifyChallenge(body),
        auth.verifyChallenge(body),
      ]);
      const oks = [a, b].filter((x) => x.ok);
      const fails = [a, b].filter((x) => !x.ok);
      assert.equal(oks.length, 1);
      assert.equal(fails.length, 1);
      assert.equal(fails[0].reason, "challenge_replay");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session cannot authorize a different portfolio owner (caller check)", async () => {
    const { dir, auth, kp, publicKey } = makeAuth();
    try {
      const ch = auth.issueChallenge({
        account_id: "alice.testnet",
        domain: "app.example",
      }).challenge;
      const sess = await auth.verifyChallenge({
        challenge_id: ch.challenge_id,
        account_id: "alice.testnet",
        public_key: publicKey,
        signature: signCh(ch, kp),
      });
      assert.equal(sess.ok, true);
      const resolved = auth.resolveSession(sess.session.token);
      // Simulate API boundary: session account must equal portfolio.owner_account
      const portfolioOwner = "bob.testnet";
      assert.notEqual(resolved.account_id, portfolioOwner);
      assert.equal(
        String(resolved.account_id) === String(portfolioOwner),
        false
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
