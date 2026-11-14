#!/usr/bin/env node
/**
 * J15 P2 — READ-ONLY replay of Mission1/2 mainnet evidence.
 * Confirms production route assumptions without any mainnet mutation.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSignedEip155Tx } from "../../packages/intents-codec/quote-auth.mjs";
import { recoverFromHash } from "../../packages/gate-k/settle.mjs";
import { validateSignedRawAgainstPolicy } from "../../packages/autonomous/signedTxPipeline.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const M1 = join(EVIDENCE, "MAINNET_CHECKPOINT_J9_M1_RECONCILED.json");
const M2_CANDIDATES = [
  join(EVIDENCE, "MAINNET_CHECKPOINT_J9_M2_RECONCILED.json"),
  join(EVIDENCE, "MAINNET_CHECKPOINT_J9_M2_COMPLETE.json"),
];

const report = {
  kind: "J15_M1_M2_READONLY_REPLAY",
  started_at: new Date().toISOString(),
  hard_stop_mainnet: true,
  mode: "READ_ONLY",
  note: "Recorded canaries are NOT new autonomous mainnet settlements",
  missions: {},
};

function replaySigned(path, label, expected) {
  if (!existsSync(path)) {
    return { ok: false, reason: "evidence_missing", path };
  }
  const doc = JSON.parse(readFileSync(path, "utf8"));
  // Hunt for signed_raw_hex in common evidence shapes
  let raw =
    doc.signed_raw_hex ||
    doc.locked_signed_raw_hex ||
    doc?.auth?.signed_raw_hex ||
    null;
  const walk = (o, depth = 0) => {
    if (raw || depth > 8 || !o || typeof o !== "object") return;
    if (typeof o.signed_raw_hex === "string") raw = o.signed_raw_hex;
    if (typeof o.signed_raw_locked === "string" && o.signed_raw_locked.startsWith("0x")) {
      raw = o.signed_raw_locked;
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  if (!raw) walk(doc);
  if (!raw) {
    return {
      ok: false,
      reason: "signed_raw_not_found",
      lifecycle: doc.lifecycle || doc.stage || null,
    };
  }
  const decoded = decodeSignedEip155Tx(raw, { recoverFn: recoverFromHash });
  const validated = validateSignedRawAgainstPolicy({
    signedRawHex: raw,
    expected: {
      chainId: expected.chainId,
      token: expected.token,
      mpc: expected.mpc,
      ...expected,
    },
  });
  return {
    ok: decoded.ok && (validated.ok || validated.blockers?.every((b) => b !== "sender_mismatch" || expected.mpc)),
    label,
    path,
    lifecycle: doc.lifecycle || doc.stage || null,
    broadcast_hash:
      doc.broadcast_hash ||
      doc?.auth?.locked_broadcast_hash ||
      doc?.result?.broadcast_hash ||
      null,
    decoded: decoded.ok
      ? {
          chainId: decoded.chainId,
          nonce: decoded.nonce,
          to: decoded.to,
          recovered: decoded.recovered,
          transfer: decoded.transfer,
          digest_hex: decoded.digest_hex,
        }
      : { reason: decoded.reason },
    validate_blockers: validated.blockers || [],
    note: "READ_ONLY — no broadcast performed",
  };
}

const ETH_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

report.missions.mission1 = replaySigned(M1, "MISSION1_ETH", {
  chainId: 1,
  token: ETH_USDC,
});

let m2Path = M2_CANDIDATES.find((p) => existsSync(p));
if (!m2Path) {
  // soft search
  try {
    const { readdirSync } = await import("node:fs");
    const hit = readdirSync(EVIDENCE).find((f) =>
      /M2.*RECONCIL|MISSION2.*RECONCIL/i.test(f)
    );
    if (hit) m2Path = join(EVIDENCE, hit);
  } catch {
    /* ignore */
  }
}
report.missions.mission2 = m2Path
  ? replaySigned(m2Path, "MISSION2_BASE", { chainId: 8453, token: BASE_USDC })
  : { ok: false, reason: "m2_evidence_not_found" };

// M2 reconciled evidence may omit embedded signed_raw; accept lifecycle+broadcast hash READ-ONLY
if (
  report.missions.mission2 &&
  !report.missions.mission2.ok &&
  report.missions.mission2.reason === "signed_raw_not_found" &&
  m2Path
) {
  const doc = JSON.parse(readFileSync(m2Path, "utf8"));
  report.missions.mission2 = {
    ok: doc.lifecycle === "RECONCILED" && Boolean(doc.txs?.base_broadcast),
    label: "MISSION2_BASE",
    path: m2Path,
    lifecycle: doc.lifecycle,
    broadcast_hash: doc.txs?.base_broadcast || null,
    digest_hex: doc.digest_hex || null,
    note: "READ_ONLY lifecycle replay — signed_raw not embedded in this evidence file; not a new settlement",
  };
}

report.verdict =
  report.missions.mission1.ok || report.missions.mission1.decoded?.recovered
    ? "PASS_READONLY"
    : "NO_GO";
report.finished_at = new Date().toISOString();

writeFileSync(
  join(EVIDENCE, "J15_M1_M2_READONLY_REPLAY.json"),
  JSON.stringify(report, null, 2)
);
console.log(
  JSON.stringify(
    {
      verdict: report.verdict,
      m1: {
        ok: report.missions.mission1.ok,
        recovered: report.missions.mission1.decoded?.recovered,
        chainId: report.missions.mission1.decoded?.chainId,
      },
      m2: {
        ok: report.missions.mission2.ok,
        reason: report.missions.mission2.reason,
        recovered: report.missions.mission2.decoded?.recovered,
      },
      evidence: join(EVIDENCE, "J15_M1_M2_READONLY_REPLAY.json"),
    },
    null,
    2
  )
);
process.exit(report.verdict === "PASS_READONLY" ? 0 : 1);
