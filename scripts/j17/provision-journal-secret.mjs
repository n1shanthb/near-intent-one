#!/usr/bin/env node
/**
 * J17.3 — Explicit one-time journal secret provision.
 * Refuses if secret already exists. Never run as part of crash recovery.
 * Does not print the secret.
 *
 * After provision, financial writers resolve via:
 *   NIO_TX_JOURNAL_SECRET | NIO_TX_JOURNAL_SECRET_PATH | default file
 */
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  journalSecretFilePath,
  journalSecretFingerprint,
  requireJournalSecret,
} from "../../packages/autonomous/j17.sepoliaPath.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const path = journalSecretFilePath(ROOT);

if (process.env.NIO_TX_JOURNAL_SECRET && String(process.env.NIO_TX_JOURNAL_SECRET).length >= 32) {
  console.log(
    JSON.stringify({
      ok: true,
      action: "noop",
      reason: "NIO_TX_JOURNAL_SECRET_already_set_in_env",
      fingerprint: journalSecretFingerprint(process.env.NIO_TX_JOURNAL_SECRET),
      note: "File not written; env takes precedence. Secret not printed.",
    })
  );
  process.exit(0);
}

if (existsSync(path)) {
  const check = requireJournalSecret({ rootDir: ROOT, allowGenerate: false });
  console.log(
    JSON.stringify({
      ok: check.ok,
      action: "refuse_regenerate",
      path: ".nio-secure/j17/journal.secret",
      NIO_TX_JOURNAL_SECRET_PATH: path,
      fingerprint: check.fingerprint || null,
      note: "Existing durable secret preserved — never regenerate on recovery",
    })
  );
  process.exit(check.ok ? 0 : 1);
}

mkdirSync(dirname(path), { recursive: true });
const secret = randomBytes(48).toString("base64url");
const tmp = `${path}.tmp`;
writeFileSync(tmp, secret + "\n", { mode: 0o600 });
renameSync(tmp, path);

console.log(
  JSON.stringify({
    ok: true,
    action: "provisioned_once",
    path: ".nio-secure/j17/journal.secret",
    NIO_TX_JOURNAL_SECRET_PATH: path,
    length: secret.length,
    fingerprint: journalSecretFingerprint(secret),
    note: "Secret written; value not printed. Set NIO_TX_JOURNAL_SECRET_PATH to this file for writers. Do not regenerate on crash.",
  })
);
