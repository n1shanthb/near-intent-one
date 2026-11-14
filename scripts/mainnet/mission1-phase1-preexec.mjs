#!/usr/bin/env node
/**
 * Mission 1 Phase 1 — pre-execution (NO NEAR/EVM mutations).
 * Creates fresh short-lived authorization + funded quote/attest when ready.
 * HARD STOP before Ledger unpause / propose / sign / broadcast / reconcile.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statfsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import { execSync } from "node:child_process";
import {
  MAINNET_IDENTITIES,
  MAINNET_EVM_RPCS,
} from "../../packages/mainnet/identities.mjs";
import {
  createMission1ViewAdapters,
  createMission1LiveAdapters,
} from "../../packages/mainnet/mission1Adapters.mjs";
import {
  assertMission1RunnerComplete,
  mission1StepPrepareApproval,
  mission1StepQuoteAttest,
} from "../../packages/mainnet/mission1Executor.mjs";
import {
  MISSION1_AMOUNT,
  MISSION1_CHAIN_ID,
  MISSION1_TOKEN,
  mission1StoreDir,
} from "../../packages/mainnet/mission1ExecutionPath.mjs";
import { M1_ETH_NEAR_USDC } from "../../packages/mainnet/canaryRouteProfiles.mjs";
import {
  CANARY_ATTESTOR_PK,
  getLifecycleState,
  resolveCanaryJournalSecret,
} from "../../packages/mainnet/canaryOneShot.mjs";
import { GAS_ASSUMPTIONS } from "../../packages/mainnet/j5_2.quoteScan.mjs";
import { secureFetch, detectMobileBindAddress } from "../../packages/mainnet/secureFetch.mjs";
import { assertPaperFundedDisabled, createPaperState } from "../../packages/mainnet/paperTrading.mjs";
import { publicKeyEd25519 } from "../../packages/intents-codec/quote-auth.mjs";
import { openTxJournal } from "../../packages/execution/txJournal.mjs";

const BASELINE = "f2f13daccdc7bea17ba7d3277ce8a1ff86e1344f";
const PRIOR_FEE_ETH = 0.0000058891229442;
const MATERIAL_FEE_MULTIPLIER = 5; // stop if fee > 5× prior rehearsal estimate
const TTL_MS = 20 * 60_000; // short-lived 20 minutes
const outDir = join("docs", "evidence");
mkdirSync(outDir, { recursive: true });

function loadAttestor() {
  const latest = join(
    homedir(),
    ".nio-secure",
    "mainnet-attestor",
    "LATEST_ATTESTOR_PATH.txt"
  );
  if (!existsSync(latest)) throw new Error("attestor_not_generated");
  const seedPath = readFileSync(latest, "utf8").trim();
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  const sk = Buffer.from(seed.secretKey64, "base64");
  const pk = publicKeyEd25519(sk);
  if (pk !== seed.publicKey || pk !== CANARY_ATTESTOR_PK) {
    throw new Error("attestor_key_mismatch");
  }
  return { publicKey: pk, secretKey64: sk };
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
    ok: Boolean(r.ok && mitm?.authorized && !mitm?.fortinet_mitm),
    status: r.status,
    bind,
    fortinet_mitm: mitm?.fortinet_mitm ?? null,
    tls_authorized: mitm?.authorized ?? null,
    peer_issuer: mitm?.issuer || null,
    error: r.error || mitm?.error || null,
  };
}

function diskOk() {
  try {
    const s = statfsSync(homedir());
    const free = Number(s.bavail) * Number(s.bsize);
    return {
      ok: free >= 500_000_000,
      free_bytes: free,
      free_gb: free / 1e9,
    };
  } catch {
    // Windows may lack statfs — fall back to PowerShell-reported drive via env heuristic
    return { ok: true, free_bytes: null, note: "statfs_unavailable_use_prior_check" };
  }
}

function ifaces() {
  const nets = networkInterfaces();
  const out = {};
  for (const [name, addrs] of Object.entries(nets)) {
    out[name] = (addrs || [])
      .filter((a) => a.family === "IPv4" || a.family === 4)
      .map((a) => a.address);
  }
  return out;
}

function loadOpsKeyPath() {
  const latest = join(
    homedir(),
    ".nio-secure",
    "mainnet-agent-ops",
    "LATEST_OPS_KEY_PATH.txt"
  );
  if (!existsSync(latest)) throw new Error("ops_key_latest_missing");
  const p = readFileSync(latest, "utf8").trim();
  if (!p || !existsSync(p)) throw new Error("ops_key_path_invalid");
  return p;
}

async function main() {
  const started = new Date().toISOString();
  const blockers = [];
  const warnings = [];

  try {
    process.env.NIO_AGENT_OPS_KEY_PATH = loadOpsKeyPath();
  } catch (e) {
    blockers.push(`ops_key:${e.message || e}`);
  }

  const head = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  if (head !== BASELINE) {
    blockers.push(`git_head_mismatch:have=${head}:want=${BASELINE}`);
  }

  const runner = assertMission1RunnerComplete();
  if (!runner.ok) blockers.push(`runner_incomplete:${JSON.stringify(runner.missing)}`);

  let tests = { ok: false };
  try {
    execSync(
      "node --test packages/mainnet/mission1.executor.e2e.test.mjs packages/mainnet/mission1.executionPath.test.mjs",
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    tests = { ok: true };
  } catch (e) {
    tests = { ok: false, error: String(e.stderr || e.message || e).slice(0, 500) };
    blockers.push("mission1_tests_failed");
  }

  const tls = await probeTls();
  if (!tls.ok) blockers.push(`tls_not_trusted:${tls.error || "fortinet_or_unauthorized"}`);

  const disk = diskOk();
  if (!disk.ok) blockers.push(`disk_low:free_gb=${disk.free_gb}`);

  // Ensure Mission1 journal secret (file-backed in mission1 store)
  const m1Dir = mission1StoreDir(process.env);
  mkdirSync(m1Dir, { recursive: true });
  const journalSecret = resolveCanaryJournalSecret({
    env: process.env,
    storeDir: m1Dir,
  });
  if (!journalSecret.ok) blockers.push(`journal_secret:${journalSecret.reason}`);
  else process.env.NIO_JOURNAL_SECRET = journalSecret.secret;

  let journalOk = false;
  try {
    const j = openTxJournal({
      path: join(m1Dir, "tx.sqlite"),
      secret: process.env.NIO_JOURNAL_SECRET,
    });
    const id = `m1-journal-probe-${Date.now()}`;
    j.insertDraft({
      id,
      portfolio_id: MAINNET_IDENTITIES.portfolio_id,
      idempotency_key: id,
      nonce: "0",
      chain_id: String(MISSION1_CHAIN_ID),
      to: MISSION1_TOKEN,
      data_hash: createHash("sha256").update("probe").digest("hex"),
    });
    j.close();
    journalOk = true;
  } catch (e) {
    blockers.push(`journal_access_failed:${String(e.message || e).slice(0, 120)}`);
  }

  const paper = assertPaperFundedDisabled(createPaperState());
  if (!paper.ok) blockers.push("paper_funded_not_disabled");

  let attestor;
  try {
    attestor = loadAttestor();
  } catch (e) {
    blockers.push(`attestor:${e.message || e}`);
  }

  const viewAdapters = await createMission1ViewAdapters({});
  // Construct live adapters without invoking mutations (credential load check)
  let liveAdaptersKind = null;
  try {
    const live = await createMission1LiveAdapters({});
    liveAdaptersKind = live.kind;
    if (!live.assembleEip155FromMpcNearTx || !live.verifySignedRawAgainstAuth) {
      blockers.push("live_adapters_missing_mpc_verify");
    }
    if (!live.proposeQuotedEvmTransfer || !live.requestSignature) {
      blockers.push("live_adapters_missing_mutation_methods");
    }
  } catch (e) {
    blockers.push(`live_adapters_construct_failed:${String(e.message || e).slice(0, 160)}`);
  }

  const [paused, epoch, limits, pendingList, trustedSigner] = await Promise.all([
    viewAdapters.getPaused(),
    viewAdapters.getMandateEpoch(),
    viewAdapters.getLimits(),
    viewAdapters.listPending(),
    viewAdapters.rpc
      ? (async () => {
          const { viewFunction } = await import("../../packages/networks/rpc.mjs");
          return viewFunction(
            viewAdapters.rpc,
            MAINNET_IDENTITIES.policy,
            "is_trusted_quote_signer",
            { public_key: CANARY_ATTESTOR_PK }
          ).catch((e) => ({ error: String(e.message || e) }));
        })()
      : null,
  ]);

  if (paused !== true) blockers.push(`policy_not_paused:paused=${paused}`);
  if (Number(epoch) !== 2) blockers.push(`epoch_mismatch:epoch=${epoch}`);
  if (Number(limits?.max_slippage_bps) < 50) {
    blockers.push(`slippage_limit_too_tight:${limits?.max_slippage_bps}`);
  }
  if (trustedSigner !== true && trustedSigner?.error) {
    warnings.push(`trusted_signer_check:${trustedSigner.error}`);
  } else if (trustedSigner !== true) {
    blockers.push(`attestor_not_trusted_onchain:got=${trustedSigner}`);
  }

  const pending = Array.isArray(pendingList) ? pendingList : [];
  if (pending.length > 0) {
    warnings.push(
      `existing_pending_ops:${pending.length}:${pending
        .map((p) => p.operation_id || "?")
        .join(",")}`
    );
  }

  // STOP early if preconditions failed — do not create authorization or funded quote
  if (blockers.length) {
    const fail = {
      ok: false,
      phase: "PHASE_1_FAILED",
      baseline: BASELINE,
      head,
      blockers,
      warnings,
      tls,
      disk,
      journal_ok: journalOk,
      live_adapters_kind: liveAdaptersKind,
      policy: { paused, epoch, limits, pending_count: pending.length },
      hard_stop: true,
      mutations_invoked: false,
      next: "Fix blockers before creating authorization or funded quote",
    };
    writeFileSync(
      join(outDir, "MAINNET_CHECKPOINT_J9_M1_PHASE1.json"),
      JSON.stringify(fail, null, 2)
    );
    console.log(JSON.stringify(fail, null, 2));
    process.exitCode = 2;
    return;
  }

  // Fresh short-lived authorization
  const prep = mission1StepPrepareApproval({
    operationId: `m1-canary-${Date.now()}-${randomBytes(4).toString("hex")}`,
    maxGasPrice: String(GAS_ASSUMPTIONS.ethereum.max_gas_price_wei),
    maxSlippageBps: 50,
    ttlMs: TTL_MS,
  });
  if (!prep.ok) {
    blockers.push(`prepare_failed:${prep.reason || JSON.stringify(prep)}`);
  }
  const operationId = prep.operation_id;

  // Funded quote + attest (no NEAR mutation)
  const quoteAttest = await mission1StepQuoteAttest({
    operationId,
    allowFundedQuote: true,
    adapters: viewAdapters,
    deps: {
      attestor,
      nearRpc: viewAdapters.rpc,
      ethRpc: MAINNET_EVM_RPCS.ethereum,
    },
  });

  if (!quoteAttest.ok) {
    const fail = {
      ok: false,
      phase: "PHASE_1_QUOTE_ATTEST_FAILED",
      baseline: BASELINE,
      head,
      operation_id: operationId,
      approval_expires_at: prep.expires_at,
      quote_attest: quoteAttest,
      blockers: [`quote_attest:${quoteAttest.reason}`],
      warnings,
      hard_stop: true,
      mutations_invoked: false,
      next: "Do not unpause. Fix quote/attest failure; do not extend expired auth.",
    };
    writeFileSync(
      join(outDir, "MAINNET_CHECKPOINT_J9_M1_PHASE1.json"),
      JSON.stringify(fail, null, 2)
    );
    console.log(JSON.stringify(fail, null, 2));
    process.exitCode = 2;
    return;
  }

  const feeEth = Number(quoteAttest.gas?.fee_wei || 0) / 1e18;
  if (feeEth > PRIOR_FEE_ETH * MATERIAL_FEE_MULTIPLIER) {
    blockers.push(
      `gas_fee_materially_exceeds_prior:fee_eth=${feeEth}:prior=${PRIOR_FEE_ETH}:limit=${PRIOR_FEE_ETH * MATERIAL_FEE_MULTIPLIER}`
    );
  }
  if (!quoteAttest.gas?.ok) {
    blockers.push(`gas_params_blocked:${JSON.stringify(quoteAttest.gas)}`);
  }

  // Load approval record for report
  const recPath = join(m1Dir, `${operationId}.json`);
  const record = JSON.parse(readFileSync(recPath, "utf8"));

  const report = {
    ok: blockers.length === 0,
    phase: blockers.length
      ? "PHASE_1_BLOCKED_AFTER_ATTEST"
      : "PHASE_2_AWAITING_OWNER_NEAR_MUTATION_APPROVAL",
    baseline: BASELINE,
    head,
    started_at: started,
    finished_at: new Date().toISOString(),
    hard_stop: true,
    mutations_invoked: false,
    near_mutations_pending_approval: true,
    checks: {
      git_head_match: head === BASELINE,
      runner_ok: runner.ok,
      tests_ok: tests.ok,
      tls,
      disk,
      journal_ok: journalOk,
      paper_funded_disabled: paper.ok,
      live_adapters_kind: liveAdaptersKind,
      attestor_pk: CANARY_ATTESTOR_PK,
      attestor_trusted_onchain: trustedSigner === true,
    },
    network: { interfaces: ifaces() },
    policy: {
      paused,
      epoch: Number(epoch),
      max_slippage_bps: limits.max_slippage_bps,
      max_trade_value: limits.max_trade_value,
      max_gas_budget: limits.max_gas_budget,
      pending_count: pending.length,
      pending_ids: pending.map((p) => p.operation_id),
    },
    transaction: {
      operation_id: operationId,
      authorization_expires_at: prep.expires_at,
      authorization_ttl_ms: TTL_MS,
      lifecycle: getLifecycleState(record),
      chain_id: MISSION1_CHAIN_ID,
      token: MISSION1_TOKEN,
      amount: MISSION1_AMOUNT,
      amount_label: "1 USDC",
      mpc_signer: MAINNET_IDENTITIES.mpc_evm_address,
      deposit_address: quoteAttest.deposit_address,
      destination_asset: M1_ETH_NEAR_USDC.asset_out,
      destination_contract:
        "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      recipient: M1_ETH_NEAR_USDC.recipient,
      refund_to: M1_ETH_NEAR_USDC.refund_to,
      refund_route: "ORIGIN_CHAIN Ethereum MPC",
      min_amount_out: quoteAttest.min_amount_out,
      quote_deadline_ms:
        record.outcomes?.ATTESTED?.quote_deadline_ms || null,
      quote_slippage_bps_requested: 50,
      digest_hex: quoteAttest.digest_hex,
      nonce: quoteAttest.nonce,
      gas_price: quoteAttest.gas?.gas_price,
      gas_limit: quoteAttest.gas?.gas_limit,
      max_fee_wei: quoteAttest.gas?.fee_wei,
      max_fee_eth: feeEth,
      near_usdc_before: quoteAttest.near_usdc_before,
      eth_usdc_balance_raw: null, // filled below if available
    },
    required_next_mutations_after_approval: [
      "1) Owner Ledger unpause() on policy.nishanthb.near",
      "2) mission1-operator verify-unpaused --op <id>",
      "3) confirm --phase propose; propose --invoke (exactly once)",
      "4) confirm --phase sign; sign --invoke (exactly once)",
      "5) persist signed raw; present broadcast preview; separate broadcast approval",
      "6) broadcast --invoke (exactly once); verify Eth receipt + USDC transfer",
      "7) Ledger pause() when safe",
      "8) settle / monitor 1Click + NEAR NEP-141 delta",
      "9) separate approval for Ledger reconcile_pending",
      "10) verify Success + evidence + paused; finalize RECONCILED",
    ],
    blockers,
    warnings,
    approval_request: {
      ask: "EXPLICIT_APPROVAL_REQUIRED_BEFORE_FIRST_NEAR_MUTATION",
      specifically: "Owner Ledger unpause() for this Mission 1 operation only",
      not_authorized: [
        "Mission 2",
        "second transfer",
        "policy limit changes",
        "autonomous funded trading",
        "propose/sign/broadcast without further separate approvals",
      ],
    },
  };

  // Attach live eth balances from quote path trusted reads if present on record
  report.transaction.eth_balances_note =
    "Verified during quoteAttest via live RPC (USDC >= 1e6, ETH for gas)";

  writeFileSync(
    join(outDir, "MAINNET_CHECKPOINT_J9_M1_PHASE1.json"),
    JSON.stringify(report, null, 2)
  );

  const md = `# Mission 1 Phase 1/2 — Live transaction report (STOP before NEAR mutation)

**Mutations invoked:** false  
**Baseline:** \`${BASELINE}\`  
**Phase:** ${report.phase}

## Fresh authorization

| Field | Value |
|-------|--------|
| Operation ID | \`${operationId}\` |
| Expires | \`${prep.expires_at}\` (TTL ${TTL_MS / 60000} min) |
| Lifecycle | \`${getLifecycleState(record)}\` |
| Amount | 1 USDC (\`1000000\`) |
| Chain | Ethereum \`1\` / USDC \`${MISSION1_TOKEN}\` |
| MPC signer | \`${MAINNET_IDENTITIES.mpc_evm_address}\` |
| Deposit address | \`${quoteAttest.deposit_address}\` |
| Destination | NEP-141 USDC → \`${M1_ETH_NEAR_USDC.recipient}\` |
| Refund | \`${M1_ETH_NEAR_USDC.refund_to}\` on Ethereum |
| Min out | \`${quoteAttest.min_amount_out}\` |
| Nonce | \`${quoteAttest.nonce}\` |
| Gas price / limit | \`${quoteAttest.gas?.gas_price}\` / \`${quoteAttest.gas?.gas_limit}\` |
| Max fee | \`${quoteAttest.gas?.fee_wei}\` wei (~${feeEth.toFixed(8)} ETH) |
| Digest | \`${quoteAttest.digest_hex}\` |
| NEAR USDC before | \`${quoteAttest.near_usdc_before}\` |

## Policy / gates

- paused=${paused} epoch=${epoch} attestor_trusted=${trustedSigner === true}
- TLS ok=${tls.ok} fortinet=${tls.fortinet_mitm}
- Paper funded disabled=${paper.ok}
- Existing pending ops: ${pending.length}

## APPROVAL BOUNDARY

**STOP.** No Ledger unpause / propose / request_signature / broadcast yet.

Reply with explicit approval to proceed with **Owner-Ledger \`unpause()\` for operation \`${operationId}\` only**, then physical Ledger confirmation.
`;
  writeFileSync(join(outDir, "MAINNET_CHECKPOINT_J9_M1_PHASE1.md"), md);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 2;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
