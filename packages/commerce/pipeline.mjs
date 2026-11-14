/**
 * NIO commerce buyer pipeline (separate from DeFi trading).
 * Discover → Fit → Critic → (optional draft) → stop before paid hire by default.
 */
import { join } from "node:path";
import {
  discoverAgentsWithPricing,
  createHireDraft,
  discardHireDraft,
  hashBrief,
  getBuyerToken,
  paymentsEnabled,
} from "./nearAgentMarketClient.mjs";
import { fitCommerceCandidates } from "./fitter.mjs";
import { criticReviewHire, sanitizeExternalAgentOutput } from "./critic.mjs";
import {
  openCommerceLedger,
  ledgerSnapshot,
  commerceGates,
  recordCommerceSpend,
} from "./budget.mjs";
import { openJobStore } from "./jobStore.mjs";

export function defaultCommercePaths(dataDir) {
  return {
    ledgerPath: join(dataDir, "commerce-ledger.json"),
    jobsPath: join(dataDir, "commerce-jobs.json"),
  };
}

export function createCommerceRuntime({ dataDir, env = process.env } = {}) {
  const paths = defaultCommercePaths(dataDir);
  const ledger = openCommerceLedger(paths.ledgerPath);
  const jobs = openJobStore(paths.jobsPath);
  return { ledger, jobs, paths, env };
}

/**
 * End-to-end observation / proposal. Does not pay unless explicitly opted in
 * AND payments enabled AND critic may_hire (still creates draft only unless force).
 */
export async function runCommerceDiscoveryPipeline(opts = {}) {
  const env = opts.env || process.env;
  const runtime = opts.runtime || createCommerceRuntime({ dataDir: opts.dataDir, env });
  const needQuery =
    opts.needQuery ||
    "blockchain research market data analysis brief";
  const brief =
    opts.brief ||
    [
      "Produce a short independent research brief (≤400 words) on current NEAR Intents / 1Click",
      "cross-chain USDC routing risks for a paused autonomous trading agent.",
      "Cite public sources only. Do not request keys, signatures, or mandate changes.",
      "Label estimates clearly. Output Markdown.",
    ].join(" ");

  const discovery = await discoverAgentsWithPricing({
    q: opts.searchQ || "research blockchain",
    category: opts.category || "research",
    sort: opts.sort || "delivered",
    limit: opts.limit || 25,
  });

  if (!discovery.ok) {
    return {
      ok: false,
      stage: "DISCOVERED",
      reason: discovery.reason,
      detail: discovery,
    };
  }

  const fit = fitCommerceCandidates(discovery.agents, {
    env,
    needQuery,
    providerAllowlist: opts.providerAllowlist || null,
  });

  const critic = criticReviewHire({
    fitted: fit.best,
    brief,
    ledger: runtime.ledger,
    env,
    providerAllowlist: opts.providerAllowlist || null,
    llmOpinion: opts.llmOpinion || null,
  });

  let job = null;
  if (fit.best?.agent) {
    job = runtime.jobs.create({
      state: "EVALUATED",
      agent_id: fit.best.agent.agent_id,
      agent_handle: fit.best.agent.handle,
      listing_url: fit.best.agent.listing_url,
      brief,
      brief_hash: hashBrief(brief),
      quoted_price_usdc: fit.best.price_usdc,
      currency: "USDC",
      fitter: {
        outcome: fit.best.outcome,
        trust_score: fit.best.trust_score,
        reason_codes: fit.best.reason_codes,
      },
      critic: {
        verdict: critic.verdict,
        reason_codes: critic.reason_codes,
        may_hire: critic.may_hire,
      },
    });
  }

  let draft = null;
  if (
    opts.createDraft === true &&
    critic.may_propose &&
    fit.best?.agent &&
    job
  ) {
    // Persist APPROVED intent before any marketplace write
    runtime.jobs.update(job.operation_id, { state: "APPROVED" });
    draft = await createHireDraft(fit.best.agent.agent_id, { brief });
    if (draft.ok) {
      runtime.jobs.update(job.operation_id, {
        state: "PAYMENT_PENDING",
        hire_draft_id: draft.draft?.hireDraftId || draft.draft?.hire_draft_id,
        receipt: { hire_draft: draft.draft, funded: false },
      });
      if (opts.discardDraftAfter === true && draft.draft?.hireDraftId) {
        await discardHireDraft(draft.draft.hireDraftId);
        runtime.jobs.update(job.operation_id, {
          state: "APPROVED",
          note: "probe_draft_discarded",
        });
      }
    } else {
      runtime.jobs.update(job.operation_id, {
        state: "FAILED",
        receipt: { draft_error: draft },
      });
    }
  }

  const budget = ledgerSnapshot(runtime.ledger, env);
  const gates = commerceGates(env);

  return {
    ok: true,
    live: true,
    mock: false,
    need_query: needQuery,
    brief,
    brief_hash: hashBrief(brief),
    discovery: {
      count: discovery.count,
      queried_at: discovery.queried_at,
    },
    fitter: {
      evaluated: fit.evaluated,
      proposable: fit.proposable,
      best: fit.best
        ? {
            agent_id: fit.best.agent.agent_id,
            handle: fit.best.agent.handle,
            name: fit.best.agent.name,
            listing_url: fit.best.agent.listing_url,
            price_usdc: fit.best.price_usdc,
            delivered_jobs: fit.best.agent.delivered_jobs,
            available_now: fit.best.agent.available_now,
            trust_score: fit.best.trust_score,
            outcome: fit.best.outcome,
            reason_codes: fit.best.reason_codes,
          }
        : null,
    },
    critic: {
      verdict: critic.verdict,
      reason_codes: critic.reason_codes,
      may_hire: critic.may_hire,
      may_propose: critic.may_propose || critic.verdict === "APPROVE_PENDING_AUTH",
    },
    operation_id: job?.operation_id || null,
    hire_draft: draft,
    budget,
    gates: {
      payments_enabled: gates.payments_enabled,
      paused: gates.paused,
      max_price_per_hire_usdc: gates.max_price_per_hire_usdc,
      max_jobs_total: gates.max_jobs_total,
      buyer_token_present: Boolean(getBuyerToken(env)),
    },
    first_purchase: {
      paid: false,
      note: "No marketplace payment executed in this pipeline run",
    },
    untrusted_output_policy: sanitizeExternalAgentOutput(""),
  };
}

export function commerceStatus(runtime, env = process.env) {
  return {
    ok: true,
    service: "nio-commerce-buyer",
    gates: commerceGates(env),
    budget: ledgerSnapshot(runtime.ledger, env),
    jobs: runtime.jobs.list().map(publicJobView),
    paid_purchases: runtime.jobs
      .list()
      .filter((j) => ["HIRED", "IN_PROGRESS", "DELIVERED", "ACCEPTED"].includes(j.state) && j.paid_amount_usdc > 0)
      .length,
    buyer_token_present: Boolean(getBuyerToken(env)),
    payments_enabled: paymentsEnabled(env),
  };
}

export function publicJobView(job) {
  if (!job) return null;
  return {
    operation_id: job.operation_id,
    state: job.state,
    agent_id: job.agent_id,
    agent_handle: job.agent_handle,
    listing_url: job.listing_url,
    market_job_id: job.market_job_id,
    hire_draft_id: job.hire_draft_id,
    quoted_price_usdc: job.quoted_price_usdc,
    paid_amount_usdc: job.paid_amount_usdc,
    currency: job.currency,
    payment_rail: job.payment_rail,
    payment_status: job.payment_status,
    delivery_hash: job.delivery_hash,
    verification: job.verification,
    tx_url: job.tx_url,
    mock: Boolean(job.mock),
    created_at: job.created_at,
    updated_at: job.updated_at,
    critic_verdict: job.critic?.verdict || null,
  };
}

/** Record a verified paid hire (only after real marketplace confirmation). */
export function recordPaidHire(runtime, {
  operationId,
  marketJobId,
  paidUsdc,
  receipt,
  txUrl = null,
}) {
  const job = runtime.jobs.update(operationId, {
    state: "HIRED",
    market_job_id: marketJobId,
    paid_amount_usdc: paidUsdc,
    payment_status: "escrow_funded",
    receipt,
    tx_url: txUrl,
    mock: false,
  });
  recordCommerceSpend(runtime.ledger, {
    operation_id: operationId,
    market_job_id: marketJobId,
    agent_id: job.agent_id,
    brief_hash: job.brief_hash,
    paid_usdc: paidUsdc,
    status: "HIRED",
  });
  return job;
}
