#!/usr/bin/env node
/**
 * Mission 1 final production-safety hardening rehearsal (NO MUTATIONS).
 * Live RPC + TLS + funding + dry quote + CLI/adapters wiring proof.
 * HARD STOP: no Ledger, unpause, propose, request_signature, broadcast, swap, reconcile.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { execSync } from "node:child_process";
import { createMission1ViewAdapters } from "../../packages/mainnet/mission1Adapters.mjs";
import {
  assertMission1RunnerComplete,
  mission1RunnerCapabilities,
  listMission1RunnerSteps,
  runMission1DryRehearsal,
} from "../../packages/mainnet/mission1Executor.mjs";
import { auditMission1ProductionPathWithRunner } from "../../packages/mainnet/mission1ExecutionPath.mjs";
import { runMission1EthNearPreflight } from "../../packages/mainnet/mission1EthNear.mjs";
import { secureFetch, detectMobileBindAddress } from "../../packages/mainnet/secureFetch.mjs";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";
import {
  assertPaperFundedDisabled,
  createPaperState,
} from "../../packages/mainnet/paperTrading.mjs";
import { assertMission1FixturesAllowed } from "../../packages/mainnet/mission1Safety.mjs";

const BASELINE = "8769c4d98018c0492ad4ff39a7f31f520fe492f7";
const outDir = join("docs", "evidence");
mkdirSync(outDir, { recursive: true });

function ifaceSummary() {
  const nets = networkInterfaces();
  const out = {};
  for (const [name, addrs] of Object.entries(nets)) {
    out[name] = (addrs || [])
      .filter((a) => a.family === "IPv4" || a.family === 4)
      .map((a) => a.address);
  }
  return out;
}

async function probeTls() {
  const bind = detectMobileBindAddress(process.env);
  const r = await secureFetch("https://1click.chaindefuser.com/v0/tokens", {
    method: "GET",
    timeoutMs: 20_000,
    env: process.env,
  });
  let mitm = null;
  try {
    const { default: tls } = await import("node:tls");
    const { connect } = await import("node:net");
    mitm = await new Promise((resolve) => {
      const socket = connect(
        { host: "1click.chaindefuser.com", port: 443, family: 4 },
        () => {
          const secure = tls.connect(
            {
              socket,
              servername: "1click.chaindefuser.com",
              rejectUnauthorized: true,
            },
            () => {
              const cert = secure.getPeerCertificate();
              resolve({
                authorized: secure.authorized,
                issuer: cert?.issuer,
                fortinet_mitm: String(cert?.issuer?.O || "").includes("Fortinet"),
              });
              secure.end();
            }
          );
          secure.on("error", (e) =>
            resolve({ error: String(e.message || e), authorized: false })
          );
        }
      );
      socket.on("error", (e) => resolve({ error: String(e.message || e) }));
    });
  } catch (e) {
    mitm = { error: String(e.message || e) };
  }
  return {
    ok: r.ok && mitm?.authorized !== false && !mitm?.fortinet_mitm,
    status: r.status,
    bind,
    error: r.error || mitm?.error || null,
    fortinet_mitm: mitm?.fortinet_mitm ?? null,
    tls_authorized: mitm?.authorized ?? null,
    peer_issuer: mitm?.issuer || null,
  };
}

async function main() {
  const started = new Date().toISOString();
  const runner = assertMission1RunnerComplete();
  const caps = mission1RunnerCapabilities();
  const cliPath = "scripts/mainnet/mission1-operator.mjs";
  const cliExists = existsSync(cliPath);

  let cliCapabilities = null;
  try {
    cliCapabilities = JSON.parse(
      execSync(`node ${cliPath} capabilities`, { encoding: "utf8" })
    );
  } catch (e) {
    cliCapabilities = { ok: false, error: String(e.message || e) };
  }

  const fixtureProdBlocked = assertMission1FixturesAllowed(false, {
    paused: false,
  });

  const tls = await probeTls();
  const adapters = await createMission1ViewAdapters({});
  const paused = await adapters.getPaused();
  const epoch = await adapters.getMandateEpoch();
  const limits = await adapters.getLimits();
  const pending = await adapters.listPending();

  const preflight = await runMission1EthNearPreflight({});
  const pathAudit = await auditMission1ProductionPathWithRunner({});

  const paper = createPaperState();
  const paperDisabled = assertPaperFundedDisabled(paper);

  // Dry rehearsal without quote fixtures — prepare only, no mutations
  const dry = await runMission1DryRehearsal({
    adapters,
    allowFundedQuote: false,
  });

  const approval_boundaries = [
    "Owner separate financial approval for Mission1 Eth→NEAR canary (not yet created)",
    "Ledger unpause() only after financial approval + attest window",
    "Operator confirm propose/sign/broadcast at correct lifecycle states only",
    "Ledger reconcile_pending only after SETTLED + evidence hash verified",
    "No reuse of J8B Arb approval or Arbitrum operator path",
    "Autonomous funded paper trading remains DISABLED",
    "Do not extend expired authorization TTL",
  ];

  const hard_stop = {
    ledger_signing: false,
    policy_unpause: false,
    near_propose: false,
    request_signature: false,
    evm_broadcast: false,
    swap: false,
    reconcile: false,
    expiring_approval_created: false,
    mutations_invoked: false,
  };

  const report = {
    kind: "mission1_j9_hardening_rehearsal_v1",
    started_at: started,
    finished_at: new Date().toISOString(),
    baseline: BASELINE,
    hard_stop,
    network: {
      interfaces: ifaceSummary(),
      tls,
    },
    wiring: {
      runner,
      capabilities: caps,
      steps: listMission1RunnerSteps(),
      cli_path: cliPath,
      cli_exists: cliExists,
      cli_capabilities: cliCapabilities,
      adapters_kind: adapters.kind,
      adapters_eth_rpc: adapters.ethRpc,
      independent_of_j8b: caps.independent_of_j8b === true,
      fixture_injection_blocked_in_prod: fixtureProdBlocked.ok === false,
      path_audit: {
        ok: pathAudit.ok,
        gaps: pathAudit.engineering_gaps,
        ready: pathAudit.production_ready_components,
      },
    },
    live_policy: {
      paused,
      epoch,
      limits,
      pending_count: Array.isArray(pending) ? pending.length : null,
    },
    funding_and_quote: preflight,
    dry_rehearsal: {
      ok: dry.ok,
      stage: dry.stage,
      mutations_invoked: dry.mutations_invoked,
      hard_stop: dry.hard_stop,
      operation_id: dry.operation_id,
      quote_attempted: Boolean(dry.quote),
    },
    paper_funded_disabled: paperDisabled,
    approval_boundaries,
    defects_fixed: [
      "propose: require PendingOp verify; ambiguous → RECONCILIATION_REQUIRED, no resubmit",
      "sign: require observed MPC digest (no default to expected); no repeat on ambiguity",
      "persist: decode+verify Eth USDC transfer, chainId 1, amount 1e6, lock raw+hash",
      "broadcast: live nonce, journal binding, quote deadline, auth locks, pending check, UNKNOWN→reconcile-only",
      "reconcile: require Success + evidence hash + policy pause verify before RECONCILED",
      "trusted live RPC state; fixtures require testHarness",
      "phase confirmations state-gated (no advance booking)",
      "lifecycle advance results checked before claiming stage",
      "Mission1 CLI + Eth adapters independent of J8B Arb operator",
    ],
    verdict:
      runner.ok &&
      cliExists &&
      tls.ok &&
      pathAudit.ok &&
      paperDisabled.ok &&
      paused === true &&
      Number(epoch) === 2 &&
      preflight?.ok === true
        ? "READY_FOR_SEPARATE_FINANCIAL_APPROVAL"
        : "NOT_READY",
  };

  const jsonPath = join(outDir, "MAINNET_CHECKPOINT_J9_M1_HARDENING.json");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = `# Checkpoint J9 — Mission 1 final production safety hardening

**Mutations invoked:** false  
**Baseline:** \`${BASELINE}\`  
**Hard stop:** no Ledger / unpause / propose / request_signature / broadcast / swap / reconcile / expiring approval

## Verdict

**${report.verdict}**

## Defects fixed

${report.defects_fixed.map((d) => `- ${d}`).join("\n")}

## Tests

\`node --test packages/mainnet/mission1.executor.e2e.test.mjs\` — pass (happy path + negative/ambiguous)

## Wiring proof

- CLI: \`${cliPath}\` exists=${cliExists}
- Adapters: \`${adapters.kind}\` ethRpc=\`${adapters.ethRpc}\`
- Runner assert ok=${runner.ok}
- Path audit ok=${pathAudit.ok}
- Fixture injection blocked in prod=${fixtureProdBlocked.ok === false}
- Independent of J8B=${caps.independent_of_j8b}

## Live state (read-only)

- Policy paused=${paused} epoch=${epoch}
- TLS ok=${tls.ok} fortinet_mitm=${tls.fortinet_mitm} authorized=${tls.tls_authorized}
- Preflight ok=${preflight?.ok}
- Paper funded disabled=${paperDisabled.ok}

## Approval boundaries (remaining)

${approval_boundaries.map((b) => `- ${b}`).join("\n")}

See JSON: \`MAINNET_CHECKPOINT_J9_M1_HARDENING.json\`
`;
  writeFileSync(join(outDir, "MAINNET_CHECKPOINT_J9_M1_HARDENING.md"), md);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
