#!/usr/bin/env node
/**
 * Checkpoint J4 — TLS-verified 1Click dry quotes + AI observation.
 * No broadcast. No funding. No Ledger.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import tls from "node:tls";
import { connect as netConnect } from "node:net";
import { secureFetch, detectMobileBindAddress } from "../../packages/mainnet/secureFetch.mjs";
import { fetchProductionTokens } from "../../packages/mainnet/intents.mjs";
import { runFourChainQuoteMatrix } from "../../packages/mainnet/multichainRouter.mjs";
import { runMainnetObservation } from "../../packages/mainnet/observe.mjs";
import { createMainnetAgentRuntime } from "../../packages/mainnet/agentRuntime.mjs";
import { mainnetExecutionGates } from "../../packages/mainnet/safetyGates.mjs";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");

function resolveKeyPath() {
  if (process.env.NIO_AGENT_OPS_KEY_PATH) return process.env.NIO_AGENT_OPS_KEY_PATH;
  const latest = join(homedir(), ".nio-secure", "mainnet-agent-ops", "LATEST_OPS_KEY_PATH.txt");
  if (existsSync(latest)) return readFileSync(latest, "utf8").trim();
  return null;
}

async function probeTls(host = "1click.chaindefuser.com") {
  const bind = detectMobileBindAddress();
  return new Promise((resolve) => {
    const socket = netConnect(
      { host, port: 443, family: 4, ...(bind ? { localAddress: bind } : {}) },
      () => {
        const s = tls.connect(
          { socket, servername: host, rejectUnauthorized: true },
          () => {
            const c = s.getPeerCertificate();
            resolve({
              ok: s.authorized,
              bind,
              node: process.version,
              subject: c.subject?.CN,
              issuerCN: c.issuer?.CN,
              issuerO: c.issuer?.O,
              fingerprint256: c.fingerprint256,
              fortinet_mitm: String(c.issuer?.O || "").includes("Fortinet"),
            });
            s.end();
          }
        );
        s.on("error", (e) =>
          resolve({ ok: false, bind, node: process.version, error: e.message })
        );
      }
    );
    socket.on("error", (e) =>
      resolve({ ok: false, bind, node: process.version, error: e.message })
    );
  });
}

process.env.NIO_NETWORK = "mainnet";
process.env.NEAR_NETWORK = "mainnet";
process.env.NIO_MAINNET_OBSERVE_ONLY = "1";
const keyPath = resolveKeyPath();
if (keyPath) process.env.NIO_AGENT_OPS_KEY_PATH = keyPath;

const tlsProbe = await probeTls();
console.error("[j4] tls", JSON.stringify(tlsProbe));

const tokens = await fetchProductionTokens();
console.error(
  "[j4] tokens",
  JSON.stringify({
    ok: tokens.ok,
    count: tokens.count,
    reason: tokens.reason,
    bind: tokens.bind,
    tls: tokens.tls,
  })
);

const mpc = MAINNET_IDENTITIES.mpc_evm_address;
const matrix = await runFourChainQuoteMatrix({
  amount: "1000000",
  balances: {},
  mandate: {
    paused: true,
    revoked: false,
    max_slippage_bps: 100,
    allowed_destinations: [mpc, MAINNET_IDENTITIES.owner],
  },
  recipient: mpc,
  refundTo: mpc,
  evmRecipient: mpc,
  evmRefund: mpc,
  nearRecipient: MAINNET_IDENTITIES.owner,
  nearRefund: MAINNET_IDENTITIES.owner,
});

const matrixRows = (matrix.matrix || []).map((r) => ({
  id: r.id,
  label: r.label,
  ok: r.ok,
  status: r.status,
  reason: r.reason || null,
  amount_out: r.amount_out ?? null,
  amount_out_usd: r.amount_out_usd ?? null,
  capital: r.capital || null,
  signing: r.signing || null,
  score: r.score ?? null,
  decision: r.decision || null,
  funded_execution: "DISABLED",
}));

let runtime = null;
if (keyPath) {
  runtime = await createMainnetAgentRuntime({ env: process.env });
}

const observe = await runMainnetObservation({
  rpc: runtime?.ok ? runtime.rpc : undefined,
  env: process.env,
});

// Attach live matrix into observation decision (quotes already inside observe;
// re-assert matrix was live and fed)
const gates = mainnetExecutionGates(process.env);

const out = {
  checkpoint: "J4",
  at: new Date().toISOString(),
  node: process.version,
  tls: tlsProbe,
  tokens: {
    ok: tokens.ok,
    count: tokens.count,
    api: tokens.api,
    bind: tokens.bind,
    tls: tokens.tls,
    reason: tokens.reason || null,
  },
  quote_matrix: {
    ok: matrix.ok,
    reason: matrix.reason || null,
    dry: true,
    funded_execution: "DISABLED",
    quoted_count: matrix.quoted_count,
    eligible_count: matrix.eligible_count,
    proposal: matrix.proposal,
    chains: matrix.chains,
    catalog_counts: matrix.catalog_counts,
    canonical_assets: matrix.canonical_assets,
    rows: matrixRows,
    note: matrix.note,
  },
  ai_observation: {
    decision: observe.decision,
    gate_j: observe.gate_j,
    enforcement: observe.enforcement,
    quotes_ok: observe.quotes?.ok,
    quote_reason: observe.quotes?.reason || null,
    policy: observe.policy,
    balances: {
      near: observe.balances?.near?.available_near,
      evm: observe.balances?.evm?.chains
        ? Object.fromEntries(
            Object.entries(observe.balances.evm.chains).map(([k, v]) => [
              k,
              { native_ether: v.native_ether, usdc_ui: v.usdc_ui, verified: v.verified },
            ])
          )
        : null,
    },
    mpc: observe.mpc,
  },
  gates: {
    funded_trading: gates.funded_trading,
    mainnet_broadcast_enabled: gates.mainnet_broadcast_enabled,
    autonomous_execution_enabled: gates.autonomous_execution_enabled,
  },
  runtime_ok: runtime?.ok === true,
  local_sign_ok: runtime?.local_sign?.ok === true,
  observation_only: true,
};

mkdirSync(EVIDENCE, { recursive: true });
const path = join(EVIDENCE, "MAINNET_CHECKPOINT_J4_OBSERVE.json");
writeFileSync(path, JSON.stringify(out, null, 2));

console.log(
  JSON.stringify(
    {
      ok: Boolean(tlsProbe.ok && tokens.ok && matrix.ok),
      evidence: path,
      tls_ok: tlsProbe.ok,
      issuer: tlsProbe.issuerCN,
      fortinet_mitm: tlsProbe.fortinet_mitm,
      tokens: tokens.count,
      quoted: matrix.quoted_count,
      eligible: matrix.eligible_count,
      proposal: matrix.proposal?.choice,
      ai: observe.decision?.choice,
      vetoes: observe.decision?.vetoes,
      gates,
    },
    null,
    2
  )
);

if (!tlsProbe.ok || !tokens.ok) process.exitCode = 2;
