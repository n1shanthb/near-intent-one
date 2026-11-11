/**
 * Owner challenge/response authentication (testnet).
 *
 * Primary scheme: NEP-413 (wallet-selector / Ledger-compatible message signing).
 * - recipient = domain (dApp binding)
 * - message embeds account + network + challenge_id + issued/expires
 * - nonce = 32 random bytes (single-use)
 * - Signature must be FullAccess key on the NEAR account
 *
 * claimed_owner alone is NEVER authentication.
 * Shared GATE_I_API_KEY is service auth, not user/owner auth.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateNep413Nonce,
  parseEd25519PublicKey,
  verifyNep413Signature,
} from "./nep413.mjs";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_CHALLENGES = 500;
const MAX_SESSIONS = 200;

function nowMs() {
  return Date.now();
}

function iso(ms = nowMs()) {
  return new Date(ms).toISOString();
}

function canonicalMessage(ch) {
  return [
    "NIO owner authentication",
    `domain: ${ch.domain}`,
    `account: ${ch.account_id}`,
    `network: ${ch.network}`,
    `challenge_id: ${ch.challenge_id}`,
    `issued: ${ch.issued_at}`,
    `expires: ${ch.expires_at}`,
  ].join("\n");
}

function isFullAccess(permission) {
  return permission === "FullAccess" || permission === "fullaccess";
}

function safeEqualStr(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

export function openOwnerAuthStore(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "owner-auth.json");
  const load = () => {
    if (!existsSync(path)) return { challenges: {}, sessions: {} };
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return { challenges: {}, sessions: {} };
    }
  };
  const save = (state) => {
    writeFileSync(path, JSON.stringify(state, null, 2));
  };
  return {
    path,
    read: load,
    update(fn) {
      const s = load();
      const next = fn(s) || s;
      save(next);
      return next;
    },
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof openOwnerAuthStore>} opts.store
 * @param {string} opts.secret — HMAC secret for session tokens
 * @param {string} [opts.network]
 * @param {(accountId:string)=>Promise<Array<{public_key:string,permission:any}>>} opts.listAccessKeys
 * @param {number} [opts.challengeTtlMs]
 * @param {number} [opts.sessionTtlMs]
 */
export function createOwnerAuth(opts) {
  const {
    store,
    secret,
    network = "testnet",
    listAccessKeys,
    challengeTtlMs = DEFAULT_TTL_MS,
    sessionTtlMs = SESSION_TTL_MS,
  } = opts;

  if (!secret || String(secret).length < 16) {
    throw new Error("owner_auth_secret_too_short");
  }

  /** Serialize verify RMW so concurrent same-challenge cannot both succeed. */
  let verifyChain = Promise.resolve();
  function exclusiveVerify(fn) {
    const run = verifyChain.then(fn, fn);
    verifyChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function prune(state) {
    const t = nowMs();
    for (const [id, ch] of Object.entries(state.challenges || {})) {
      if (ch.used || Date.parse(ch.expires_at) < t) delete state.challenges[id];
    }
    for (const [id, sess] of Object.entries(state.sessions || {})) {
      if (Date.parse(sess.expires_at) < t) delete state.sessions[id];
    }
    const chIds = Object.keys(state.challenges || {});
    if (chIds.length > MAX_CHALLENGES) {
      for (const id of chIds.slice(0, chIds.length - MAX_CHALLENGES)) {
        delete state.challenges[id];
      }
    }
    const sIds = Object.keys(state.sessions || {});
    if (sIds.length > MAX_SESSIONS) {
      for (const id of sIds.slice(0, sIds.length - MAX_SESSIONS)) {
        delete state.sessions[id];
      }
    }
    return state;
  }

  function issueChallenge({ account_id, domain, callback_url = null }) {
    const accountId = String(account_id || "").trim();
    const dom = String(domain || "").trim().toLowerCase();
    if (!accountId || accountId.length < 2 || accountId.length > 64) {
      return { ok: false, reason: "invalid_account_id" };
    }
    if (!dom || dom.length > 253 || /\s/.test(dom)) {
      return { ok: false, reason: "invalid_domain" };
    }
    if (network !== "testnet") {
      return { ok: false, reason: "wrong_network" };
    }

    const issued = nowMs();
    const challenge_id = randomBytes(16).toString("hex");
    const nonceBytes = generateNep413Nonce();
    const ch = {
      challenge_id,
      account_id: accountId,
      domain: dom,
      network,
      scheme: "nep413",
      nonce_b64: nonceBytes.toString("base64"),
      callback_url: callback_url ? String(callback_url) : null,
      issued_at: iso(issued),
      expires_at: iso(issued + challengeTtlMs),
      used: false,
    };
    ch.message = canonicalMessage(ch);

    store.update((s) => {
      prune(s);
      s.challenges[challenge_id] = ch;
      return s;
    });

    return {
      ok: true,
      challenge: {
        scheme: "nep413",
        challenge_id: ch.challenge_id,
        account_id: ch.account_id,
        /** NEP-413 recipient — must equal domain for NIO binding */
        recipient: ch.domain,
        domain: ch.domain,
        network: ch.network,
        nonce: ch.nonce_b64,
        nonce_encoding: "base64",
        callback_url: ch.callback_url,
        issued_at: ch.issued_at,
        expires_at: ch.expires_at,
        message: ch.message,
        /** wallet-selector: signMessage({ message, recipient, nonce, callbackUrl }) */
        wallet_sign_message: {
          message: ch.message,
          recipient: ch.domain,
          nonce: ch.nonce_b64,
          callbackUrl: ch.callback_url || undefined,
        },
        algorithm: "ed25519",
        note: "Sign with a FullAccess key via NEP-413 (SHA-256 of tagged Borsh payload). Do not sign raw UTF-8.",
      },
    };
  }

  async function verifyChallenge(body) {
    // Serialize so concurrent verifies of the same challenge cannot both succeed.
    return exclusiveVerify(() => verifyChallengeLocked(body));
  }

  async function verifyChallengeLocked({
    challenge_id,
    account_id,
    public_key,
    signature,
    domain,
    recipient,
  }) {
    const state = store.read();
    const ch = state.challenges?.[challenge_id];
    if (!ch) return { ok: false, reason: "challenge_not_found" };
    if (ch.used) return { ok: false, reason: "challenge_replay" };
    if (Date.parse(ch.expires_at) < nowMs()) {
      return { ok: false, reason: "challenge_expired" };
    }
    if (ch.network !== network) return { ok: false, reason: "wrong_network" };
    if (!safeEqualStr(ch.account_id, String(account_id || ""))) {
      return { ok: false, reason: "account_mismatch" };
    }
    const claimedDomain = String(domain || recipient || "")
      .trim()
      .toLowerCase();
    if (claimedDomain && !safeEqualStr(ch.domain, claimedDomain)) {
      return { ok: false, reason: "domain_mismatch" };
    }

    let normalizedPk;
    try {
      normalizedPk = parseEd25519PublicKey(public_key).normalized;
    } catch {
      return { ok: false, reason: "invalid_signature_encoding" };
    }

    let okSig = false;
    try {
      okSig = verifyNep413Signature({
        message: ch.message,
        nonce: Buffer.from(ch.nonce_b64, "base64"),
        recipient: ch.domain,
        callbackUrl: ch.callback_url,
        publicKey: normalizedPk,
        signature,
      });
    } catch {
      return { ok: false, reason: "invalid_signature_encoding" };
    }
    if (!okSig) return { ok: false, reason: "bad_signature" };

    let keys;
    try {
      keys = await listAccessKeys(ch.account_id);
    } catch (e) {
      return {
        ok: false,
        reason: "access_key_lookup_failed",
        detail: String(e.message || e).slice(0, 200),
      };
    }

    const keyRow = (keys || []).find(
      (k) =>
        String(k.public_key) === normalizedPk ||
        String(k.public_key) === String(public_key)
    );
    if (!keyRow) {
      return { ok: false, reason: "public_key_not_on_account" };
    }
    if (!isFullAccess(keyRow.permission)) {
      return { ok: false, reason: "full_access_key_required" };
    }

    // Re-check used under the exclusive lock immediately before minting session.
    const latest = store.read().challenges?.[challenge_id];
    if (!latest || latest.used) {
      return { ok: false, reason: "challenge_replay" };
    }

    const session_id = randomBytes(16).toString("hex");
    const exp = nowMs() + sessionTtlMs;
    const token = signSessionToken({
      session_id,
      account_id: ch.account_id,
      expires_at_ms: exp,
      secret,
    });

    store.update((s) => {
      prune(s);
      if (s.challenges[challenge_id]) s.challenges[challenge_id].used = true;
      s.sessions[session_id] = {
        session_id,
        account_id: ch.account_id,
        domain: ch.domain,
        public_key: normalizedPk,
        scheme: "nep413",
        issued_at: iso(),
        expires_at: iso(exp),
      };
      return s;
    });

    return {
      ok: true,
      session: {
        token,
        session_id,
        account_id: ch.account_id,
        domain: ch.domain,
        network,
        expires_at: iso(exp),
        public_key: normalizedPk,
        scheme: "nep413",
      },
    };
  }

  function resolveSession(token) {
    const parsed = verifySessionToken(token, secret);
    if (!parsed.ok) return parsed;
    const sess = store.read().sessions?.[parsed.session_id];
    if (!sess) return { ok: false, reason: "session_not_found" };
    if (Date.parse(sess.expires_at) < nowMs()) {
      return { ok: false, reason: "session_expired" };
    }
    if (!safeEqualStr(sess.account_id, parsed.account_id)) {
      return { ok: false, reason: "session_account_mismatch" };
    }
    return {
      ok: true,
      account_id: sess.account_id,
      session_id: sess.session_id,
      domain: sess.domain,
      public_key: sess.public_key,
      expires_at: sess.expires_at,
    };
  }

  function revokeSession(token) {
    const parsed = verifySessionToken(token, secret);
    if (!parsed.ok) return parsed;
    store.update((s) => {
      delete s.sessions[parsed.session_id];
      return s;
    });
    return { ok: true };
  }

  return {
    issueChallenge,
    verifyChallenge,
    resolveSession,
    revokeSession,
    canonicalMessage,
  };
}

export function signSessionToken({ session_id, account_id, expires_at_ms, secret }) {
  const payload = `${session_id}.${account_id}.${expires_at_ms}`;
  const mac = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 32);
  return `nio1.${payload}.${mac}`;
}

export function verifySessionToken(token, secret) {
  const raw = String(token || "");
  // nio1.<session_id>.<account_id>.<expires_ms>.<mac32>
  // account_id may contain dots (e.g. alice.testnet)
  const m = /^nio1\.([a-f0-9]+)\.(.+)\.(\d+)\.([a-f0-9]{32})$/.exec(raw);
  if (!m) return { ok: false, reason: "malformed_session" };
  const sid = m[1];
  const acct = m[2];
  const exp = Number(m[3]);
  const mac = m[4];
  if (!Number.isFinite(exp) || exp < nowMs()) {
    return { ok: false, reason: "session_expired" };
  }
  const payload = `${sid}.${acct}.${exp}`;
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("hex")
    .slice(0, 32);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_session_mac" };
  }
  return { ok: true, session_id: sid, account_id: acct, expires_at_ms: exp };
}

export { canonicalMessage };
