#!/usr/bin/env node
/**
 * Owner Ledger: activate_autonomous_mandate then optional --unpause.
 *
 * Judge-friendly renew (10d, trade-friendlier micro limits):
 *   node scripts/mainnet/activate-mandate.mjs --activate --days 10 --profile judge
 *   node scripts/mainnet/activate-mandate.mjs --activate --days 10 --profile judge --unpause-now
 *
 * Narrow demo (legacy $1/$5/$2, 24h):
 *   node scripts/mainnet/activate-mandate.mjs --activate
 *   node scripts/mainnet/activate-mandate.mjs --unpause
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";
import { LEDGER_HD, NEAR_CLI } from "./j18-deploy-upgrade.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
const ARGS_DIR = join(homedir(), ".nio-secure", "mainnet-demo");
mkdirSync(ARGS_DIR, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

const RPCS = [
  process.env.NIO_MAINNET_RPC,
  "https://rpc.mainnet.near.org",
  "https://rpc.mainnet.fastnear.com",
].filter(Boolean);

const PROFILES = {
  /** Original micro-canary — tight for first enable. */
  demo: {
    max_trade_value: "1000000", // $1
    daily_turnover_limit: "5000000", // $5
    max_pending_exposure: "2000000", // $2
    max_slippage_bps: 100,
    days: 1,
    policy_hash: "nio-mainnet-demo-mandate-v1",
  },
  /**
   * Judge / real-swap window — still micro, but room for Intents quotes.
   * $5 / $25 / $10 / 200 bps / 10 days.
   */
  judge: {
    max_trade_value: "5000000", // $5
    daily_turnover_limit: "25000000", // $25
    max_pending_exposure: "10000000", // $10
    max_slippage_bps: 200,
    days: 10,
    policy_hash: "nio-mainnet-judge-mandate-v1",
  },
};

function argValue(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

async function viewFn(url, methodName, args = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: MAINNET_IDENTITIES.policy,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) return { error: j.error || j.result.error };
  return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
}

async function pickRpc() {
  for (const u of RPCS) {
    try {
      const res = await fetch(u, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "status",
          params: [],
        }),
      });
      if (!(await res.json()).error) return u;
    } catch {
      /* next */
    }
  }
  throw new Error("no_rpc");
}

function runNear(args) {
  if (!existsSync(NEAR_CLI)) return { ok: false, error: `near_cli_missing:${NEAR_CLI}` };
  const r = spawnSync(NEAR_CLI, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
    windowsHide: false,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").slice(-8000),
    stderr: (r.stderr || "").slice(-8000),
  };
}

function resolveProfile() {
  const name = argValue("--profile", "demo");
  const base = PROFILES[name];
  if (!base) {
    throw new Error(`unknown_profile:${name} (use demo|judge)`);
  }
  const days = Number(argValue("--days", String(base.days)));
  if (!Number.isFinite(days) || days < 1 || days > 30) {
    throw new Error("days must be 1..30");
  }
  return {
    name,
    days,
    max_trade_value: argValue("--max-trade", base.max_trade_value),
    daily_turnover_limit: argValue("--daily", base.daily_turnover_limit),
    max_pending_exposure: argValue("--pending", base.max_pending_exposure),
    max_slippage_bps: Number(argValue("--slippage", String(base.max_slippage_bps))),
    policy_hash: base.policy_hash,
    unpause_now: process.argv.includes("--unpause-now"),
  };
}

function buildArgs(liveLimits, profile) {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const until = nowNs + BigInt(profile.days) * 24n * 3600n * 1_000_000_000n;
  // Keep destinations + chains/venues from live; never invent new destinations.
  const demoAssets = [
    "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "nep141:wrap.near",
  ];
  const liveAssets = liveLimits.allowed_assets || [];
  const allowed_assets = demoAssets.filter((a) => liveAssets.includes(a));
  if (allowed_assets.length === 0) {
    throw new Error("no_overlapping_assets_with_live_allowlist");
  }
  const expiresAt = new Date(Number(until / 1_000_000n));
  return {
    preview: {
      profile: profile.name,
      days: profile.days,
      expires_at_utc: expiresAt.toISOString(),
      max_trade_usdc: Number(profile.max_trade_value) / 1e6,
      daily_usdc: Number(profile.daily_turnover_limit) / 1e6,
      pending_usdc: Number(profile.max_pending_exposure) / 1e6,
      slippage_bps: profile.max_slippage_bps,
      unpause_now: profile.unpause_now,
    },
    args: {
      limits: {
        max_trade_value: String(profile.max_trade_value),
        daily_turnover_limit: String(profile.daily_turnover_limit),
        max_pending_exposure: String(profile.max_pending_exposure),
        max_slippage_bps: profile.max_slippage_bps,
        allowed_assets,
        allowed_destinations: liveLimits.allowed_destinations,
        valid_until: until.toString(),
        token_scope: "allowlist",
        allowed_chains: liveLimits.allowed_chains,
        allowed_venues: liveLimits.allowed_venues,
        max_gas_budget: liveLimits.max_gas_budget || "2500000000000000",
      },
      policy_hash: profile.policy_hash,
      strategy_hash: "nio-live-llm-fitter-v1",
      enforce_autonomous_on_agent: true,
      autonomous_trading: true,
      unpause_now: Boolean(profile.unpause_now),
    },
  };
}

async function main() {
  const doActivate = process.argv.includes("--activate");
  const doUnpause = process.argv.includes("--unpause");
  const dryRun = process.argv.includes("--dry-run");
  if (!doActivate && !doUnpause) {
    console.error(
      "Usage: --activate [--profile judge|demo] [--days N] [--unpause-now] [--dry-run] | --unpause"
    );
    process.exit(2);
  }

  const url = await pickRpc();
  const enforce = await viewFn(url, "get_enforce_autonomous_on_agent");
  if (enforce?.error) {
    const blocker = {
      kind: "MAINNET_MANDATE_ACTIVE",
      verdict: "BLOCKED",
      blocker: "WASM_NOT_UPGRADED",
      detail: enforce.error,
      next: "Deploy audit WASM + migrate first",
    };
    writeFileSync(join(EVIDENCE, "MAINNET_MANDATE_ACTIVE.json"), JSON.stringify(blocker, null, 2));
    console.log(JSON.stringify(blocker, null, 2));
    process.exit(1);
  }

  const report = {
    kind: doActivate ? "MAINNET_MANDATE_ACTIVE" : "MAINNET_UNPAUSED",
    started_at: new Date().toISOString(),
    policy: MAINNET_IDENTITIES.policy,
    owner: MAINNET_IDENTITIES.owner,
  };

  if (doActivate) {
    const profile = resolveProfile();
    const liveLimits = await viewFn(url, "get_limits");
    if (liveLimits?.error) throw new Error(JSON.stringify(liveLimits.error));
    const { preview, args } = buildArgs(liveLimits, profile);
    const argsPath = join(ARGS_DIR, "activate_autonomous_mandate.args.json");
    writeFileSync(argsPath, JSON.stringify(args));
    writeFileSync(
      join(EVIDENCE, "MAINNET_DEMO_MANDATE_ARGS.json"),
      JSON.stringify({ kind: "MAINNET_DEMO_MANDATE_ARGS", preview, args, argsPath }, null, 2)
    );
    report.preview = preview;
    report.args = args;
    report.args_path = argsPath;
    console.error(JSON.stringify({ preview, args_path: argsPath }, null, 2));

    if (dryRun) {
      report.verdict = "DRY_RUN";
      writeFileSync(join(EVIDENCE, "MAINNET_MANDATE_ACTIVE.json"), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    console.error(
      `LEDGER: confirm activate_autonomous_mandate (unpause_now=${args.unpause_now})...`
    );
    const r = runNear([
      "contract",
      "call-function",
      "as-transaction",
      MAINNET_IDENTITIES.policy,
      "activate_autonomous_mandate",
      "file-args",
      argsPath,
      "prepaid-gas",
      "80.0 Tgas",
      "attached-deposit",
      "0 NEAR",
      "sign-as",
      MAINNET_IDENTITIES.owner,
      "network-config",
      "mainnet",
      "sign-with-ledger",
      "--seed-phrase-hd-path",
      LEDGER_HD,
      "usb",
      "send",
    ]);
    report.call = r;
    await new Promise((x) => setTimeout(x, 2500));
    report.post = {
      epoch: await viewFn(url, "get_mandate_epoch"),
      autonomous: await viewFn(url, "get_autonomous_trading"),
      enforce: await viewFn(url, "get_enforce_autonomous_on_agent"),
      paused: await viewFn(url, "get_paused"),
      limits: await viewFn(url, "get_limits"),
    };
    const limitsOk =
      String(report.post.limits?.max_trade_value) === String(args.limits.max_trade_value) &&
      String(report.post.limits?.valid_until) === String(args.limits.valid_until);
    report.verdict =
      r.ok &&
      report.post.autonomous === true &&
      report.post.enforce === true &&
      limitsOk &&
      (args.unpause_now ? report.post.paused === false : true)
        ? "PASS"
        : "FAIL";
    writeFileSync(join(EVIDENCE, "MAINNET_MANDATE_ACTIVE.json"), JSON.stringify(report, null, 2));
  }

  if (doUnpause) {
    const unpausePath = join(ARGS_DIR, "unpause.args.json");
    writeFileSync(unpausePath, "{}");
    console.error("LEDGER: confirm unpause on policy.nishanthb.near...");
    const r = runNear([
      "contract",
      "call-function",
      "as-transaction",
      MAINNET_IDENTITIES.policy,
      "unpause",
      "file-args",
      unpausePath,
      "prepaid-gas",
      "30.0 Tgas",
      "attached-deposit",
      "0 NEAR",
      "sign-as",
      MAINNET_IDENTITIES.owner,
      "network-config",
      "mainnet",
      "sign-with-ledger",
      "--seed-phrase-hd-path",
      LEDGER_HD,
      "usb",
      "send",
    ]);
    report.call = r;
    await new Promise((x) => setTimeout(x, 2500));
    report.post = {
      paused: await viewFn(url, "get_paused"),
      autonomous: await viewFn(url, "get_autonomous_trading"),
      enforce: await viewFn(url, "get_enforce_autonomous_on_agent"),
    };
    report.verdict = r.ok && report.post.paused === false ? "PASS" : "FAIL";
    writeFileSync(join(EVIDENCE, "MAINNET_UNPAUSED.json"), JSON.stringify(report, null, 2));
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === "PASS" || report.verdict === "DRY_RUN" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
