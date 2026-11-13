#!/usr/bin/env node
/**
 * Checkpoint J3 — one-shot mainnet observation + local sign check.
 * No broadcast. Writes evidence JSON without secrets.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createMainnetAgentRuntime } from "../../packages/mainnet/agentRuntime.mjs";
import { runMainnetObservation } from "../../packages/mainnet/observe.mjs";
import { assertMainnetBroadcastAllowed } from "../../packages/mainnet/safetyGates.mjs";
import { redactSecrets } from "../../packages/mainnet/agentCredentials.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");

function resolveKeyPath() {
  if (process.env.NIO_AGENT_OPS_KEY_PATH) return process.env.NIO_AGENT_OPS_KEY_PATH;
  const latest = join(homedir(), ".nio-secure", "mainnet-agent-ops", "LATEST_OPS_KEY_PATH.txt");
  if (existsSync(latest)) return readFileSync(latest, "utf8").trim();
  throw new Error("NIO_AGENT_OPS_KEY_PATH unset and no LATEST_OPS_KEY_PATH.txt");
}

process.env.NIO_NETWORK = "mainnet";
process.env.NEAR_NETWORK = "mainnet";
process.env.NIO_AGENT_OPS_KEY_PATH = resolveKeyPath();
process.env.NIO_MAINNET_OBSERVE_ONLY = process.env.NIO_MAINNET_OBSERVE_ONLY || "1";

const runtime = await createMainnetAgentRuntime({ env: process.env });
if (!runtime.ok) {
  console.error(JSON.stringify(redactSecrets(runtime), null, 2));
  process.exit(1);
}

const observe = await runMainnetObservation({
  rpc: runtime.rpc,
  env: process.env,
});

const broadcastProbe = await runtime.submitTransaction({});
const gate = assertMainnetBroadcastAllowed(process.env);

const summary = {
  checkpoint: "J3",
  at: new Date().toISOString(),
  network: "mainnet",
  wiring: "PASS",
  local_sign: runtime.local_sign,
  policy: runtime.policy,
  gates: runtime.gates,
  agent: observe.agent,
  mpc: observe.mpc,
  balances: {
    near_available: observe.balances.near.available_near,
    evm: observe.balances.evm?.chains
      ? Object.fromEntries(
          Object.entries(observe.balances.evm.chains).map(([k, v]) => [
            k,
            {
              native_ether: v.native_ether,
              usdc_ui: v.usdc_ui,
              verified: v.verified,
            },
          ])
        )
      : null,
  },
  decision: observe.decision,
  quotes: {
    ok: observe.quotes?.ok,
    reason: observe.quotes?.reason || null,
    detail: observe.quotes?.detail || null,
    quoted_count: observe.quotes?.quoted_count ?? null,
    eligible_count: observe.quotes?.eligible_count ?? null,
    proposal: observe.quotes?.proposal || null,
    chains: observe.quotes?.chains || ["NEAR", "Ethereum", "Arbitrum", "Base"],
  },
  gate_j: observe.gate_j,
  broadcast_probe: broadcastProbe,
  gate_check: gate,
  observation_only: true,
};

mkdirSync(EVIDENCE, { recursive: true });
const outPath = join(EVIDENCE, "MAINNET_CHECKPOINT_J3_OBSERVE.json");
writeFileSync(outPath, JSON.stringify(summary, null, 2));

console.log(
  JSON.stringify(
    {
      ok: true,
      evidence: outPath,
      local_sign: summary.local_sign?.ok,
      paused: summary.policy?.paused,
      epoch: summary.policy?.mandate_epoch,
      decision: summary.decision?.choice,
      vetoes: summary.decision?.vetoes,
      quoted_count: summary.quotes?.quoted_count,
      near: summary.balances.near_available,
      evm: summary.balances.evm,
      broadcast_blocked: broadcastProbe?.ok === false,
    },
    null,
    2
  )
);
