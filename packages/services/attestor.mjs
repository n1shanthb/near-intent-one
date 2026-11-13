/**
 * Gate I3 — independently scoped quote attestor service.
 * Holds ed25519 attestor seed in memory/file — never logs secret material.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  attestTidepoolQuote,
  publicKeyEd25519,
} from "../intents-codec/quote-auth.mjs";

export function loadOrCreateAttestor(seedPath) {
  mkdirSync(join(seedPath, ".."), { recursive: true });
  if (existsSync(seedPath)) {
    const seed = JSON.parse(readFileSync(seedPath, "utf8"));
    const sk = Buffer.from(seed.secretKey64, "base64");
    return {
      publicKey: seed.publicKey || publicKeyEd25519(sk),
      secretKey64: sk,
      path: seedPath,
    };
  }
  const kp = nacl.sign.keyPair();
  const sk = Buffer.from(kp.secretKey);
  const publicKey = `ed25519:${bs58.encode(kp.publicKey)}`;
  writeFileSync(
    seedPath,
    JSON.stringify({ publicKey, secretKey64: sk.toString("base64") }, null, 2)
  );
  return { publicKey, secretKey64: sk, path: seedPath };
}

export function createAttestorService({ seedPath, logger = console }) {
  const attestor = loadOrCreateAttestor(seedPath);
  logger.info?.(`[attestor] ready pk=${attestor.publicKey}`);
  return {
    publicKey: attestor.publicKey,
    /** Never returns secretKey */
    health() {
      return { ok: true, role: "attestor", publicKey: attestor.publicKey };
    },
    attest(args) {
      // Mainnet funded: allowUnverifiedOneClick is prohibited inside attestTidepoolQuote.
      const result = attestTidepoolQuote({
        ...args,
        secretKey64: attestor.secretKey64,
        allowUnverifiedOneClick: Boolean(args.allowUnverifiedOneClick),
        mainnetFundedPath: Boolean(args.mainnetFundedPath),
      });
      // Strip nothing secret from response — attestation has no seed
      return {
        ok: result.ok,
        checks: result.checks,
        attestation: result.attestation,
        signature: result.signature,
        publicKey: result.publicKey,
        attestation_id: result.attestation_id,
        trust_model: result.trust_model,
      };
    },
  };
}
