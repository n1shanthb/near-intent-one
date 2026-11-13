/**
 * Load agent ops credentials from an explicit secure backend path.
 * Never logs private_key / key-file contents / signed tx bytes.
 */
import { readFileSync, existsSync } from "node:fs";
import { KeyPair } from "near-api-js";
import { MAINNET_IDENTITIES } from "./identities.mjs";

export class CredentialError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.name = "CredentialError";
  }
}

/**
 * Resolve key path from env. Never falls back to repo .near-credentials.
 */
export function resolveOpsKeyPath(env = process.env) {
  const p = String(env.NIO_AGENT_OPS_KEY_PATH || "").trim();
  if (!p) {
    throw new CredentialError(
      "missing_secure_credential",
      "NIO_AGENT_OPS_KEY_PATH is required for mainnet agent backend"
    );
  }
  const norm = p.replace(/\\/g, "/").toLowerCase();
  if (
    norm.includes("/.near-credentials/") ||
    norm.includes("apps/web") ||
    norm.includes("/public/")
  ) {
    throw new CredentialError(
      "insecure_credential_path",
      "Ops key must not live under browser bundles or legacy repo credential dirs"
    );
  }
  return p;
}

/**
 * Load and validate credential JSON. Returns KeyPair + public metadata only.
 * Callers must never print `private_key` or `keyPair.toString()`.
 */
export function loadAgentOpsCredentials(opts = {}) {
  const env = opts.env || process.env;
  const expectedAccount = opts.accountId || MAINNET_IDENTITIES.agent;
  const expectedPub = opts.expectedPublicKey || MAINNET_IDENTITIES.ops_public_key;
  const path = opts.path || resolveOpsKeyPath(env);

  if (!existsSync(path)) {
    throw new CredentialError("missing_secure_credential", `key file not found`);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CredentialError("credential_parse_error", "invalid credential JSON");
  }

  if (!raw || typeof raw !== "object") {
    throw new CredentialError("credential_parse_error");
  }
  if (raw.account_id && raw.account_id !== expectedAccount) {
    throw new CredentialError(
      "wrong_account",
      `credential account_id must be ${expectedAccount}`
    );
  }
  if (!raw.private_key || typeof raw.private_key !== "string") {
    throw new CredentialError("missing_private_key_field");
  }
  if (!String(raw.private_key).startsWith("ed25519:")) {
    throw new CredentialError("invalid_private_key_format");
  }

  let keyPair;
  try {
    keyPair = KeyPair.fromString(raw.private_key);
  } catch {
    throw new CredentialError("invalid_private_key");
  }

  const derivedPub = keyPair.getPublicKey().toString();
  const filePub = raw.public_key ? String(raw.public_key) : derivedPub;
  if (filePub !== derivedPub) {
    throw new CredentialError("public_private_mismatch");
  }
  if (derivedPub !== expectedPub) {
    throw new CredentialError(
      "wrong_public_key",
      `expected ${expectedPub}`
    );
  }

  return {
    account_id: expectedAccount,
    public_key: derivedPub,
    path,
    keyPair,
    /** Redacted summary safe to log */
    log_safe: {
      account_id: expectedAccount,
      public_key: derivedPub,
      path_set: true,
      private_key_present: true,
    },
  };
}

/** Safe redaction helper for any object that might contain secrets. */
export function redactSecrets(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (
      lk.includes("private") ||
      lk.includes("secret") ||
      lk === "signed" ||
      lk.includes("signed_tx") ||
      lk.includes("signedraw") ||
      lk.includes("signature_json") ||
      lk === "rawhex" ||
      lk === "raw_hex" ||
      lk === "big_r" ||
      lk === "affine_point" ||
      lk === "scalar" ||
      lk.includes("seed")
    ) {
      out[k] = "[REDACTED]";
    } else if (v && typeof v === "object") {
      out[k] = redactSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
