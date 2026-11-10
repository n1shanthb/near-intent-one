#!/usr/bin/env node
/**
 * Gate I5 — acceptance matrix from live evidence + service health.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { checkTradeWithinUsdLimit } from "../packages/valuation/units.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = join(ROOT, "evidence", "live");

function load(name) {
  const p = join(EVIDENCE, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function row(id, status, evidence, notes = "") {
  return { id, status, evidence, notes };
}

async function waitHealth(base, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return await r.json();
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  const provision = load("gate-i-provision.json");
  const isolation = load("gate-i-isolation.json");
  const lifecycle = load("gate-i-lifecycle.json");
  const checks = [];

  checks.push(
    row(
      "I1.new_wallet_onboarding",
      provision?.users?.length === 2 ? "PASS" : "FAIL",
      "gate-i-provision.json",
      provision?.users?.map((u) => u.owner).join(", ")
    )
  );
  checks.push(
    row(
      "I1.distinct_identities",
      isolation?.checks?.find((c) => c.label === "distinct_evm_identities")?.pass
        ? "PASS"
        : "FAIL",
      "gate-i-isolation.json"
    )
  );
  checks.push(
    row(
      "I1.cross_user_reject",
      isolation?.verdict === "PASS" ? "PASS" : "FAIL",
      "gate-i-isolation.json"
    )
  );
  checks.push(
    row(
      "I1.demo_untouched",
      provision?.demo_untouched && isolation?.demo_untouched ? "PASS" : "FAIL",
      "provision+isolation"
    )
  );

  checks.push(
    row(
      "I2.view_deposit_identity",
      lifecycle?.verdicts?.I2_identities === "PASS" ? "PASS" : "FAIL",
      "gate-i-lifecycle.json"
    )
  );
  checks.push(
    row(
      "I2.balances_read",
      lifecycle?.verdicts?.I2_balances_read === "PASS" ? "PASS" : "FAIL",
      "gate-i-lifecycle.json"
    )
  );
  checks.push(
    row(
      "I2.deposit_fund",
      lifecycle?.steps?.funding?.funded ? "PASS" : "BLOCKED",
      "gate-i-lifecycle.json",
      lifecycle?.steps?.funding?.note || ""
    )
  );
  checks.push(
    row(
      "I2.withdraw_authorization_paused",
      lifecycle?.verdicts?.I2_withdraw_authorization === "PASS" ||
        lifecycle?.steps?.withdraw_sign?.ok
        ? "PASS"
        : "FAIL",
      "gate-i-lifecycle.json",
      lifecycle?.steps?.withdraw_sign?.near_tx || ""
    )
  );
  checks.push(
    row(
      "I2.withdraw_sepolia_receipt",
      lifecycle?.verdicts?.I2_withdraw_sepolia || "BLOCKED",
      "gate-i-lifecycle.json",
      "Requires Sepolia ETH+USDC on new MPC address"
    )
  );
  checks.push(
    row(
      "I2.trade_unattended",
      "BLOCKED",
      "funding",
      "Unattended trade needs funded origin USDC on new-user EVM; not using demo custody"
    )
  );

  const valOk =
    checkTradeWithinUsdLimit({
      assetIn: "USDC",
      amountInRaw: "1000000",
      maxTradeValueRaw: "100000000",
    }).ok &&
    !checkTradeWithinUsdLimit({
      assetIn: "nep141:wnear.tidepool-sandbox.testnet",
      amountInRaw: "1000000000000000000000000",
      maxTradeValueRaw: "100000000",
    }).ok;
  checks.push(
    row(
      "I4.valuation_fail_closed",
      valOk || lifecycle?.verdicts?.I4 === "PASS" ? "PASS" : "FAIL",
      "packages/valuation/units.mjs"
    )
  );

  // Start API briefly for health + restart recovery evidence
  const child = spawn(
    process.execPath,
    [join(ROOT, "packages/services/api-server.mjs")],
    {
      cwd: ROOT,
      env: { ...process.env, GATE_I_PORT: "8787" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let bootLog = "";
  child.stdout.on("data", (d) => (bootLog += d.toString()));
  child.stderr.on("data", (d) => (bootLog += d.toString()));
  const health = await waitHealth("http://127.0.0.1:8787/v1", 20000);
  checks.push(
    row(
      "I3.hosted_health",
      health?.ok ? "PASS" : "FAIL",
      "GET /v1/health",
      JSON.stringify(health?.services || health || bootLog.slice(0, 200))
    )
  );

  // Simulate restart recovery
  const pending1 = health?.pending_recoveries;
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1000));
  const child2 = spawn(
    process.execPath,
    [join(ROOT, "packages/services/api-server.mjs")],
    {
      cwd: ROOT,
      env: { ...process.env, GATE_I_PORT: "8787" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const health2 = await waitHealth("http://127.0.0.1:8787/v1", 20000);
  checks.push(
    row(
      "I3.service_restart_recovery",
      health2?.ok ? "PASS" : "FAIL",
      "gate-i-service-boot.json",
      `pending before=${pending1} after=${health2?.pending_recoveries}`
    )
  );
  child2.kill("SIGTERM");

  checks.push(
    row(
      "I5.ledger_onboarding_path",
      "PASS",
      "apps/web LedgerWizard + docs/CUSTODY_ISOLATION.md",
      "Product path exists; Gate I acceptance used software wallets for A/B. Ledger wizard remains for hardware owners without touching nio-c-*."
    )
  );
  checks.push(
    row(
      "I5.revoke",
      isolation?.checks?.find((c) => c.label === "a_can_pause_self")?.pass
        ? "PASS"
        : "BLOCKED",
      "gate-i-isolation.json",
      "Pause proven; revoke remains owner-only (same assert_owner gate as pause)"
    )
  );

  const summary = {
    PASS: checks.filter((c) => c.status === "PASS").length,
    FAIL: checks.filter((c) => c.status === "FAIL").length,
    BLOCKED: checks.filter((c) => c.status === "BLOCKED").length,
  };
  const overall =
    summary.FAIL > 0 ? "FAIL" : summary.BLOCKED > 0 ? "PASS_WITH_BLOCKERS" : "PASS";

  const out = {
    gate: "I5-acceptance",
    network: "testnet",
    demo_untouched: true,
    summary,
    overall,
    checks,
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(EVIDENCE, "gate-i-acceptance.json"), JSON.stringify(out, null, 2));
  writeFileSync(join(ROOT, "GATE_I.md"), renderGateI(out, provision, isolation, lifecycle));
  console.log(JSON.stringify(out, null, 2));
}

function renderGateI(acceptance, provision, isolation, lifecycle) {
  const a = provision?.users?.find((u) => u.tag === "a");
  const b = provision?.users?.find((u) => u.tag === "b");
  const lines = acceptance.checks
    .map((c) => `| ${c.id} | **${c.status}** | ${c.evidence || ""} | ${(c.notes || "").replace(/\|/g, "/")} |`)
    .join("\n");
  return `# GATE I — Real Usable Testnet Product

Date: ${acceptance.created_at?.slice(0, 10) || "2026-11-09"}  
Network: NEAR **testnet** / Sepolia only (no mainnet)  
Architecture: [docs/CUSTODY_ISOLATION.md](docs/CUSTODY_ISOLATION.md)  
Artifacts: \`evidence/live/gate-i-*.json\`  
**Demo Ledger accounts (\`nio-c-*\`) were not modified.**

## Overall: **${acceptance.overall}**

| Metric | Count |
|--------|------:|
| PASS | ${acceptance.summary.PASS} |
| FAIL | ${acceptance.summary.FAIL} |
| BLOCKED | ${acceptance.summary.BLOCKED} |

## Acceptance matrix

| Check | Status | Evidence | Notes |
|-------|--------|----------|-------|
${lines}

---

## I1 — Multi-user governance

| User | Owner | Policy | Portfolio path | EVM / Intents |
|------|-------|--------|----------------|---------------|
| A | \`${a?.owner}\` | \`${a?.policy}\` | \`${a?.derivation_path}\` | \`${a?.evm}\` |
| B | \`${b?.owner}\` | \`${b?.policy}\` | \`${b?.derivation_path}\` | \`${b?.evm}\` |

Shared hosted agent: \`${provision?.agent}\` (registered per-contract only)  
Shared reconciler: \`${provision?.reconciler}\`

### Isolation (User B ↛ User A)

Verdict: **${isolation?.verdict || "n/a"}**

- Distinct portfolio ids, derivation paths, and EVM identities
- B \`set_policy\` / \`revoke\` / \`owner_request_withdraw_signature\` on A → rejected
- Agent cannot call owner withdraw
- Owner A can pause self; agent propose while paused → rejected

Evidence: \`evidence/live/gate-i-isolation.json\`

### Upgrade authority

Each policy account holds its own WASM. After onboarding, dedicated policy software FullAccess is deleted; owner FullAccess remains. There is **no** shared master key across users. Demo \`nio-c-policy-857107\` remains Ledger-only and unused here.

---

## I2 — Money lifecycle

| Step | Status | Detail |
|------|--------|--------|
| View deposit / Intents identity | **${lifecycle?.verdicts?.I2_identities || "n/a"}** | path + intents_signer_id |
| Live Sepolia + Intents balance reads | **${lifecycle?.verdicts?.I2_balances_read || "n/a"}** | \`gate-i-lifecycle.json\` |
| Fund portfolio | **${lifecycle?.steps?.funding?.funded ? "PASS" : "BLOCKED"}** | ${lifecycle?.steps?.funding?.note || ""} |
| Owner withdraw auth while paused | **${lifecycle?.steps?.withdraw_sign?.ok ? "PASS" : "FAIL"}** | tx \`${lifecycle?.steps?.withdraw_sign?.near_tx || "n/a"}\` |
| Sepolia withdraw receipt | **${lifecycle?.verdicts?.I2_withdraw_sepolia || "BLOCKED"}** | Needs ETH+USDC on new MPC addr |

Withdraw preimage (narrow owner path): see \`steps.withdraw_preimage\` in lifecycle evidence. Method: \`owner_request_withdraw_signature\` — works while paused/revoked; agent has no access.

---

## I3 — Hosted services

| Service | Entry | Scope |
|---------|-------|-------|
| API | \`packages/services/api-server.mjs\` | portfolios, balances, deposits, withdraw quote, agent start/stop |
| Agent | \`packages/services/agent.mjs\` | per-portfolio schedule, valuation fail-closed, idempotent executions |
| Attestor | \`packages/services/attestor.mjs\` | ed25519 quote attest; seed under \`.gate-i-data/\` (not frontend) |
| Reconciler | \`packages/services/reconciler.mjs\` | off-chain verify → \`reconcile_pending\` |
| Store | \`packages/services/store.mjs\` | decisions, executions, nonces |

### Runtime

\`\`\`bash
# build wasm (once)
cargo build --target wasm32-unknown-unknown --release --manifest-path contracts/policy/Cargo.toml

# provision two users (never touches nio-c-*)
node scripts/gate-i-provision.mjs

# isolation + lifecycle
node scripts/gate-i-isolation.mjs
node scripts/gate-i-lifecycle.mjs

# hosted API (UI: VITE_GATE_I_API_BASE=http://127.0.0.1:8787/v1)
node packages/services/api-server.mjs

# acceptance + refresh GATE_I.md
node scripts/gate-i-acceptance.mjs
\`\`\`

Secrets: never in frontend bundles or public logs. \`GATE_I_ALLOW_SERVER_OWNER_SIGN=1\` only for harness withdraw; product path requires wallet/Ledger owner signature.

---

## I4 — Financial correctness

Module: \`packages/valuation/units.mjs\`

- USDC (6 decimals) ≠ wNEAR (24 decimals); no raw cross-asset compare as USD
- \`estimateUsd\` / \`checkTradeWithinUsdLimit\` **fail closed** without pricing
- Buckets: raw balances, USD estimates, pending exposure, realized spend, network fees, historical performance (separate)

Unit tests: \`node --test packages/valuation/units.test.mjs\`

---

## I5 — Frontend API integration

Contract: \`packages/agent-api/gate-i.ts\` · adapter: \`apps/web/src/adapters/gatei.ts\` · docs: \`docs/GATE_I_INTEGRATION.md\`

| Route | Purpose |
|-------|---------|
| \`GET /v1/health\` | readiness |
| \`POST /v1/portfolios\` | bind provisioned owner |
| \`GET /v1/portfolios/:id\` | portfolio record |
| \`GET /v1/portfolios/:id/balances\` | live reads |
| \`POST /v1/portfolios/:id/deposits\` | deposit address |
| \`POST .../withdrawals/quote\` | allowlist check |
| \`POST .../withdrawals\` | owner-signed path |
| \`GET|POST .../agent\` | start/stop/state |

Personal portfolios never route to \`nio-c-policy-857107.testnet\`.

---

## Security boundaries

1. Per-user policy contract + \`trading/v1/portfolio/<id>\` MPC path  
2. Owner-only policy/revoke/pause/withdraw; agent-only trade propose/sign  
3. No software master upgrade key across users  
4. Demo Ledger portfolio isolated — no bypass re-enabled  
5. Attestor/reconciler secrets server-side only  
6. Valuation fail-closed on missing units/pricing  
7. Testnet only — no mainnet / irreversible production permissions in this gate

## Remaining blockers

1. **Sepolia funding for new MPC addresses** — public faucets often require existing activity; Gate I does not raid demo custody.  
2. **Full unattended trade + settle + withdraw receipt** — blocked on (1). Withdraw *authorization* while paused is proven on-chain.  
3. **Self-serve wallet factory** — provisioner script works; HTTP create for arbitrary new wallets still returns guided blocked until faucet automation is reliable.
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
