/**
 * Independent commerce budget — NOT the DeFi trading mandate ($1/trade, $5/day).
 * Demo defaults: $0.50 max per job, 1 job total, payments OFF.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export const DEMO_COMMERCE_LIMITS = Object.freeze({
  max_price_per_hire_usdc: 0.5,
  max_jobs_total: 1,
  max_jobs_per_day: 1,
  daily_budget_usdc: 0.5,
  allowed_currencies: Object.freeze(["USDC"]),
  auto_repeat: false,
  payments_default: false,
});

export function commerceGates(env = process.env) {
  const paused = env.NIO_COMMERCE_PAUSED === "1" || env.NIO_COMMERCE_KILL_SWITCH === "1";
  const payments =
    env.NIO_COMMERCE_PAYMENTS_ENABLED === "1" && !paused;
  return Object.freeze({
    paused,
    kill_switch: env.NIO_COMMERCE_KILL_SWITCH === "1",
    payments_enabled: payments,
    max_price_per_hire_usdc: Number(
      env.NIO_COMMERCE_MAX_PRICE_USDC || DEMO_COMMERCE_LIMITS.max_price_per_hire_usdc
    ),
    max_jobs_total: Number(
      env.NIO_COMMERCE_MAX_JOBS_TOTAL || DEMO_COMMERCE_LIMITS.max_jobs_total
    ),
    max_jobs_per_day: Number(
      env.NIO_COMMERCE_MAX_JOBS_PER_DAY || DEMO_COMMERCE_LIMITS.max_jobs_per_day
    ),
    daily_budget_usdc: Number(
      env.NIO_COMMERCE_DAILY_BUDGET_USDC || DEMO_COMMERCE_LIMITS.daily_budget_usdc
    ),
    allowed_currencies: DEMO_COMMERCE_LIMITS.allowed_currencies,
    auto_repeat: false,
    note: "Independent of trading mandate per_trade/day limits",
  });
}

export function openCommerceLedger(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          spent_usdc: 0,
          jobs: [],
          updated_at: new Date().toISOString(),
        },
        null,
        2
      )
    );
  }
  return {
    path,
    read() {
      return JSON.parse(readFileSync(path, "utf8"));
    },
    write(data) {
      data.updated_at = new Date().toISOString();
      writeFileSync(path, JSON.stringify(data, null, 2));
    },
  };
}

export function ledgerSnapshot(ledger, env = process.env) {
  const gates = commerceGates(env);
  const data = ledger.read();
  const jobs = data.jobs || [];
  const day = new Date().toISOString().slice(0, 10);
  const jobsToday = jobs.filter((j) => String(j.at || "").startsWith(day));
  const spentToday = jobsToday.reduce((s, j) => s + Number(j.paid_usdc || 0), 0);
  const remainingJobs = Math.max(0, gates.max_jobs_total - jobs.length);
  const remainingDaily =
    Math.max(0, gates.daily_budget_usdc - spentToday);
  return {
    spent_usdc: Number(data.spent_usdc || 0),
    jobs_count: jobs.length,
    jobs_today: jobsToday.length,
    spent_today_usdc: spentToday,
    remaining_jobs_total: remainingJobs,
    remaining_daily_usdc: remainingDaily,
    gates,
    available_budget_usdc: Math.min(
      remainingDaily,
      remainingJobs > 0 ? gates.max_price_per_hire_usdc : 0
    ),
  };
}

/**
 * Deterministic spend check — outside the LLM.
 */
export function assertCommerceSpendAllowed({
  priceUsdc,
  currency = "USDC",
  agentId,
  briefHash,
  ledger,
  env = process.env,
  providerAllowlist = null,
} = {}) {
  const gates = commerceGates(env);
  const snap = ledgerSnapshot(ledger, env);
  const reasons = [];

  if (gates.paused || gates.kill_switch) reasons.push("commerce_paused");
  if (!gates.payments_enabled) reasons.push("payments_disabled");
  if (!gates.allowed_currencies.includes(String(currency).toUpperCase())) {
    reasons.push("currency_not_allowed");
  }
  if (!(priceUsdc >= 0) || !Number.isFinite(priceUsdc)) reasons.push("invalid_price");
  if (priceUsdc > gates.max_price_per_hire_usdc) reasons.push("over_max_price_per_hire");
  if (snap.jobs_count >= gates.max_jobs_total) reasons.push("job_count_cap");
  if (snap.jobs_today >= gates.max_jobs_per_day) reasons.push("daily_job_cap");
  if (priceUsdc > snap.remaining_daily_usdc) reasons.push("daily_budget_exhausted");
  if (providerAllowlist && providerAllowlist.length) {
    if (!providerAllowlist.includes(agentId)) reasons.push("provider_not_allowlisted");
  }
  const data = ledger.read();
  const dup = (data.jobs || []).find(
    (j) => j.agent_id === agentId && j.brief_hash === briefHash && j.status !== "FAILED"
  );
  if (dup) reasons.push("duplicate_purchase");

  return {
    ok: reasons.length === 0,
    reasons,
    gates,
    snapshot: snap,
    price_usdc: priceUsdc,
  };
}

export function recordCommerceSpend(ledger, entry) {
  const data = ledger.read();
  data.jobs = data.jobs || [];
  data.jobs.push({
    ...entry,
    at: entry.at || new Date().toISOString(),
  });
  data.spent_usdc = Number(data.spent_usdc || 0) + Number(entry.paid_usdc || 0);
  ledger.write(data);
  return data;
}
