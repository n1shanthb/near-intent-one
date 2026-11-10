/**
 * Gate J HTTP handlers — mounted by api-server.mjs.
 * Authenticated mutations; dry-run by default.
 * Live LLM requires portfolio_id → on-chain mandate hydration (fail closed).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runGateJPipeline,
  scenarioAllowed,
  scenarioAdapted,
  scenarioRejected,
  fetchMarketSnapshot,
  getLlmConfig,
  resetSpendState,
  getSpendState,
  seedSpendState,
  withMaxSpendUsd,
  usdcRawFromUsd,
  createDemoQuota,
  demoQuotaConfig,
  clientKeyFromMeta,
} from "../gate-j/index.mjs";
import {
  hydrateMandateFromChain,
  revalidateMandate,
} from "../gate-j/hydrate.mjs";
import { verifyPortfolioBalances } from "../gate-j/balances.mjs";
import { rateLimitCheck } from "../gate-j/rateLimit.mjs";

const DEMO_FORBIDDEN_BODY_KEYS = Object.freeze([
  "allow_execute",
  "confirm_funded_trade",
  "acceptance_override",
  "gate_k_execute",
  "may_sign",
  "withdraw",
  "withdrawal",
  "set_policy",
  "mutate_policy",
  "operator_confirm",
]);

function fixtureMandateFromPortfolio(p, body = {}) {
  return {
    portfolio_id: p.portfolio_id || p.id,
    owner_account: p.owner_account,
    policy_contract: p.policy_contract,
    policy_hash: body.policy_hash || p.policy_hash || "runtime-unhashed",
    policy_version: body.policy_version || p.policy_version || null,
    revoked: !!body.revoked,
    paused: !!body.paused,
    allowed_assets: body.allowed_assets || ["USDC", "wNEAR"],
    allowed_networks: body.allowed_networks || [
      "sepolia",
      "sepolia+intents",
      "near-intents",
    ],
    per_trade_limit_usdc_raw: String(
      body.per_trade_limit_usdc_raw || usdcRawFromUsd(body.per_trade_limit_usd || 20)
    ),
    daily_limit_usdc_raw: String(
      body.daily_limit_usdc_raw || usdcRawFromUsd(body.daily_limit_usd || 100)
    ),
    daily_spent_usdc_raw: String(body.daily_spent_usdc_raw || "0"),
    balance_usdc_raw: String(
      body.balance_usdc_raw || usdcRawFromUsd(body.balance_usd || 50)
    ),
    reserved_pending_exposure: String(body.reserved_pending_exposure || "0"),
    max_pending_exposure: String(body.max_pending_exposure || "100000000"),
    max_slippage_bps: Number(body.max_slippage_bps ?? 100),
    recent_operation_sizes: body.recent_operation_sizes || [],
    source: "fixture_or_store_only",
  };
}

export function createGateJHandlers({
  store,
  evidenceDir,
  dataDir,
  viewFunction,
  fetchUsdcBalance,
  fetchEthBalance,
  fetchIntentsUsdc,
}) {
  mkdirSync(dataDir, { recursive: true });
  const historyPath = join(dataDir, "gate-j-decisions.json");
  const demoQuota = createDemoQuota({ dataDir });

  const loadHistory = () => {
    if (!existsSync(historyPath)) return [];
    try {
      return JSON.parse(readFileSync(historyPath, "utf8"));
    } catch {
      return [];
    }
  };
  const saveHistory = (rows) => {
    writeFileSync(historyPath, JSON.stringify(rows.slice(-200), null, 2));
  };

  async function resolveMandate(body) {
    const useLlm = body.use_llm === true;
    const scenarioOnly =
      !body.portfolio_id &&
      ["ALLOWED", "ADAPTED", "REJECTED"].includes(body.scenario);

    // Live LLM: portfolio_id required; on-chain hydration required; client mandate cannot weaken.
    if (useLlm) {
      if (!body.portfolio_id) {
        return {
          ok: false,
          reason: "portfolio_id_required_for_live_llm",
        };
      }
      if (!viewFunction) {
        return { ok: false, reason: "on_chain_view_unavailable" };
      }
      const portfolio = store.getPortfolio(body.portfolio_id);
      if (!portfolio) return { ok: false, reason: "portfolio_not_found" };
      if (String(portfolio.owner_account || "").startsWith("nio-c-")) {
        return { ok: false, reason: "demo_portfolio_forbidden" };
      }
      if (
        body.claimed_owner &&
        String(body.claimed_owner) !== String(portfolio.owner_account)
      ) {
        return { ok: false, reason: "wrong_portfolio_owner" };
      }

      if (!fetchUsdcBalance) {
        return { ok: false, reason: "BALANCE_UNVERIFIED", detail: "no_balance_fetcher" };
      }
      const bal = await verifyPortfolioBalances({
        fetchSepoliaUsdcRaw: fetchUsdcBalance,
        fetchSepoliaEthWei: fetchEthBalance,
        fetchIntentsUsdc,
        intents_signer_id: portfolio.intents_signer_id,
        claimed_balance_usdc_raw: body.balance_usdc_raw || null,
      });
      if (!bal.ok) {
        return {
          ok: false,
          reason: bal.reason || "BALANCE_UNVERIFIED",
          checks: bal.checks,
          detail: bal.detail || null,
          balances: bal,
        };
      }

      const hydrated = await hydrateMandateFromChain({
        view: (accountId, method, args) => viewFunction(accountId, method, args),
        portfolio,
        balance_usdc_raw: bal.balance_usdc_raw,
        claimed_owner: body.claimed_owner || null,
        clientMandate: body.mandate || null,
      });
      if (!hydrated.ok) {
        return {
          ok: false,
          reason: hydrated.reason || "mandate_hydration_failed",
          checks: hydrated.checks,
          detail: hydrated.detail || hydrated.error || null,
          balances: bal,
        };
      }
      return {
        ok: true,
        mandate: hydrated.mandate,
        portfolio,
        revalidate_key: hydrated.revalidate_key,
        hydration_checks: hydrated.checks,
        balances: bal,
        strategist_balances: bal.strategist_balances,
      };
    }

    // Fixture / scenario demos (no LLM) — still refuse demo owners
    if (body.portfolio_id) {
      const portfolio = store.getPortfolio(body.portfolio_id);
      if (!portfolio) return { ok: false, reason: "portfolio_not_found" };
      if (String(portfolio.owner_account || "").startsWith("nio-c-")) {
        return { ok: false, reason: "demo_portfolio_forbidden" };
      }
      // Prefer on-chain when view available even for fixtures
      if (viewFunction && body.hydrate !== false) {
        let balance_usdc_raw = null;
        let bal = null;
        if (fetchUsdcBalance && portfolio.intents_signer_id) {
          bal = await verifyPortfolioBalances({
            fetchSepoliaUsdcRaw: fetchUsdcBalance,
            fetchSepoliaEthWei: fetchEthBalance,
            fetchIntentsUsdc,
            intents_signer_id: portfolio.intents_signer_id,
          });
          if (bal.ok) balance_usdc_raw = bal.balance_usdc_raw;
        }
        const hydrated = await hydrateMandateFromChain({
          view: (accountId, method, args) => viewFunction(accountId, method, args),
          portfolio,
          balance_usdc_raw,
          clientMandate: body.mandate || null,
          claimed_owner: body.claimed_owner || null,
        });
        if (hydrated.ok) {
          return {
            ok: true,
            mandate: hydrated.mandate,
            portfolio,
            revalidate_key: hydrated.revalidate_key,
            hydration_checks: hydrated.checks,
            balances: bal,
            strategist_balances: bal?.strategist_balances,
          };
        }
        // Explicit fixture override only when hydrate=false
        if (body.allow_fixture_mandate === true) {
          return {
            ok: true,
            mandate: fixtureMandateFromPortfolio(portfolio, body.mandate || body),
            portfolio,
            revalidate_key: null,
            hydration_checks: hydrated.checks,
            note: "fixture_mandate_allowed_explicitly",
          };
        }
        return {
          ok: false,
          reason: hydrated.reason || "mandate_hydration_failed",
          checks: hydrated.checks,
        };
      }
      return {
        ok: true,
        mandate: fixtureMandateFromPortfolio(portfolio, body.mandate || body),
        portfolio,
        revalidate_key: null,
      };
    }

    if (scenarioOnly) {
      const s =
        body.scenario === "ALLOWED"
          ? scenarioAllowed()
          : body.scenario === "ADAPTED"
            ? scenarioAdapted()
            : scenarioRejected();
      return { ok: true, mandate: s.mandate, portfolio: null, scenario: s };
    }

    if (body.mandate && body.allow_detached_mandate === true) {
      return {
        ok: true,
        mandate: body.mandate,
        portfolio: null,
        note: "detached_mandate_explicit_dev_only",
      };
    }

    return { ok: false, reason: "mandate_or_portfolio_required" };
  }

  return {
    async market(reqBody = {}) {
      const snap = await fetchMarketSnapshot({
        fixture: reqBody.fixture || null,
      });
      return { ok: true, market: snap, llm: getLlmConfig() };
    },

    async decide(body = {}, meta = {}) {
      const dryRun = body.dry_run !== false;
      const allowExecute =
        body.allow_execute === true && body.confirm_funded_trade === true;
      if (allowExecute && !dryRun) {
        return {
          ok: false,
          reason: "funded_execution_requires_explicit_user_authorization_flag",
          hint: "Keep dry_run true unless Chat 1 operator sets confirm_funded_trade after approval",
        };
      }

      // Hard-disable funded AI execution
      if (body.use_llm === true) {
        const rl = rateLimitCheck({
          key: `llm:${meta.apiKeyHash || meta.ip || "anon"}`,
        });
        if (!rl.ok) return { ok: false, ...rl };

        const cfg = getLlmConfig();
        if (!cfg.configured) {
          return { ok: false, reason: "OPENROUTER_NOT_CONFIGURED" };
        }
        if (cfg.provider !== "openrouter") {
          return { ok: false, reason: "OPENROUTER_REQUIRED" };
        }
        // Demo path seeds persistent daily spend; do not wipe it.
        if (!meta.preserveSpend) {
          resetSpendState();
        }
      }

      const resolved = await resolveMandate(body);
      if (!resolved.ok) return resolved;

      const { mandate, portfolio, revalidate_key, scenario } = resolved;

      const strategistBalances =
        resolved.strategist_balances ||
        body.balances ||
        (mandate?.balance_usdc_raw
          ? {
              usdc: String(Number(mandate.balance_usdc_raw) / 1e6),
              usdc_raw: mandate.balance_usdc_raw,
              source: mandate.balance_source || "mandate",
            }
          : {});

      const trace = await runGateJPipeline({
        mandate,
        balances: strategistBalances,
        fixtureProposal:
          body.proposal ||
          (body.use_llm ? null : scenario?.proposal || null),
        marketFixture: body.market_fixture || scenario?.market || null,
        criticFixture:
          body.critic_fixture ||
          (body.use_llm ? null : scenario?.critic || "APPROVE"),
        useLlm: body.use_llm === true,
        dryRun: true,
        allowExecute: false,
        forecast: body.forecast || null,
      });
      trace.balance_verification = resolved.balances || null;

      // Revalidate authoritative policy after pipeline (signing still disabled)
      let revalidation = null;
      if (revalidate_key && viewFunction && portfolio) {
        revalidation = await revalidateMandate({
          view: (accountId, method, args) => viewFunction(accountId, method, args),
          portfolio,
          balance_usdc_raw:
            resolved.balances?.balance_usdc_raw || mandate.balance_usdc_raw,
          expected_revalidate_key: revalidate_key,
        });
        if (!revalidation.ok) {
          const prior = trace.enforcement?.reason_codes || [];
          const codes = [...new Set([...prior, revalidation.reason])];
          trace.enforcement = {
            ...(trace.enforcement || {}),
            decision: "NO_TRADE",
            reason_codes: codes,
            may_sign: false,
            policy_revalidation: revalidation.reason,
          };
          trace.summary = {
            ...(trace.summary || {}),
            final_decision: "NO_TRADE",
            may_sign: false,
            policy_revalidation: revalidation.reason,
          };
        }
      }

      store.recordDecision({
        kind: "gate_j",
        at: new Date().toISOString(),
        portfolio_id: mandate.portfolio_id,
        summary: trace.summary,
      });

      const hist = loadHistory();
      hist.push({
        at: trace.finished_at,
        portfolio_id: mandate.portfolio_id,
        summary: trace.summary,
        fitter_outcome: trace.summary?.fitter_outcome,
        operation_id: trace.summary?.operation_id,
        mandate_source: mandate.source || null,
      });
      saveHistory(hist);

      const evidencePayload = {
        gate: "J",
        hosted: true,
        dry_run: true,
        DRY_RUN: true,
        no_signing: true,
        funded_execution: false,
        mandate_source: mandate.source,
        mandate: {
          portfolio_id: mandate.portfolio_id,
          owner_account: mandate.owner_account,
          policy_contract: mandate.policy_contract,
          policy_hash: mandate.policy_hash,
          mandate_epoch: mandate.mandate_epoch,
          revoked: mandate.revoked,
          paused: mandate.paused,
          per_trade_limit_usdc_raw: mandate.per_trade_limit_usdc_raw,
          balance_usdc_raw: mandate.balance_usdc_raw,
          balance_source: mandate.balance_source,
          daily_remaining_usdc_raw: mandate.daily_remaining_usdc_raw,
          reserved_pending_exposure: mandate.reserved_pending_exposure,
          unresolved_pending: mandate.unresolved_pending,
          signed_unsettled_count: mandate.signed_unsettled_count,
          source: mandate.source,
          as_of: mandate.as_of,
        },
        balances: resolved.balances || null,
        hydration_checks: resolved.hydration_checks || [],
        revalidation,
        llm: getLlmConfig(),
        spend: getSpendState(),
        trace,
      };

      if (evidenceDir) {
        try {
          mkdirSync(evidenceDir, { recursive: true });
          const name =
            body.use_llm === true
              ? `gate-j-hosted-live-llm.json`
              : `gate-j-decision-${Date.now()}.json`;
          writeFileSync(
            join(evidenceDir, name),
            JSON.stringify(evidencePayload, null, 2)
          );
        } catch {
          /* optional */
        }
      }

      return {
        ok: true,
        dry_run: true,
        DRY_RUN: true,
        no_signing: true,
        portfolio_id: mandate.portfolio_id,
        mandate_source: mandate.source,
        mandate_epoch: mandate.mandate_epoch,
        policy_hash: mandate.policy_hash,
        summary: trace.summary,
        researcher: trace.researcher,
        strategist: trace.strategist,
        fitter: {
          // Pre-critic fit (mandate-only) — ALLOWED/ADAPTED may appear here even if critic later vetoes
          pre_critic: {
            outcome: trace.fitter?.outcome,
            fitted_proposal: trace.fitter?.fitted_proposal,
            parameters_changed: trace.fitter?.parameters_changed,
            reason_codes: trace.fitter?.reason_codes,
            operation_id: trace.fitter?.operation_id,
          },
          outcome: trace.fitter_after_critic?.outcome,
          fitted_proposal: trace.fitter_after_critic?.fitted_proposal,
          parameters_changed: trace.fitter_after_critic?.parameters_changed,
          reason_codes: trace.fitter_after_critic?.reason_codes,
          constraints_checked: trace.fitter_after_critic?.constraints_checked,
          economic_viability: trace.fitter_after_critic?.economic_viability,
          operation_id: trace.fitter_after_critic?.operation_id,
          policy_hash: trace.fitter_after_critic?.policy_hash,
        },
        critic: trace.critic?.review,
        enforcement: trace.enforcement,
        market: trace.market,
        balances: resolved.balances || null,
        spend: getSpendState(),
        revalidation,
        note: "LLM and Fitter outputs are never signing authorization",
      };
    },

    history(limit = 50) {
      return { ok: true, decisions: loadHistory().slice(-limit).reverse() };
    },

    scenarios() {
      return {
        ok: true,
        scenarios: ["ALLOWED", "ADAPTED", "REJECTED"],
        note: "POST /v1/gate-j/decide with { scenario, dry_run: true } for fixtures; live LLM requires portfolio_id + OpenRouter; public judges use POST /v1/gate-j/demo-decide",
      };
    },

    demoStatus() {
      return demoQuota.getStatus();
    },

    /**
     * Public judge LIVE AI DRY RUN — server-enforced demo mode.
     * Ignores/overrides client fields; never signs; fixed portfolio.
     */
    async demoDecide(_body = {}, meta = {}) {
      const cfg = demoQuotaConfig();
      const body = _body && typeof _body === "object" ? _body : {};

      // Reject obviously dangerous intent keys (defense in depth; we ignore them anyway).
      for (const k of DEMO_FORBIDDEN_BODY_KEYS) {
        if (body[k] === true) {
          return {
            ok: false,
            reason: "DEMO_FORBIDDEN_FIELD",
            field: k,
            note: "Demo endpoint refuses signing / Gate K / policy mutation fields",
          };
        }
      }

      // Hard-lock identity + modes regardless of browser input.
      const locked = {
        portfolio_id: cfg.portfolioId,
        claimed_owner: cfg.claimedOwner,
        use_llm: true,
        dry_run: true,
        allow_execute: false,
        confirm_funded_trade: false,
        acceptance_override: false,
        gate_k_execute: false,
        may_sign: false,
      };

      // Drop client mandate / fixture escapes — hydrate on-chain only.
      const clientKey = clientKeyFromMeta(meta);
      const gate = demoQuota.beginRequest({ clientKey });
      if (!gate.ok) {
        return {
          ...gate,
          demo: true,
          DRY_RUN: true,
          no_signing: true,
          may_sign: false,
        };
      }

      const spendBefore = getSpendState().usd;
      // Seed persistent daily spend into in-memory LLM cap (do NOT reset to 0).
      seedSpendState({ usd: gate.spend_usd_before });
      const restoreSpendCap = withMaxSpendUsd(gate.max_spend_usd);

      let counted = false;
      let out;
      const started = Date.now();
      const timeoutMs = cfg.timeoutMs;
      try {
        const cfgLlm = getLlmConfig();
        if (!cfgLlm.configured) {
          out = { ok: false, reason: "OPENROUTER_NOT_CONFIGURED", demo: true };
        } else if (cfgLlm.provider !== "openrouter") {
          out = { ok: false, reason: "OPENROUTER_REQUIRED", demo: true };
        } else {
          const decidePromise = this.decide(
            {
              ...locked,
              // Explicitly omit mandate / fixture knobs
            },
            { ...meta, preserveSpend: true, demo: true }
          );
          let timer;
          const timed = await Promise.race([
            decidePromise.then((r) => ({ kind: "ok", r })),
            new Promise((resolve) => {
              timer = setTimeout(
                () => resolve({ kind: "timeout" }),
                Math.max(5_000, timeoutMs)
              );
            }),
          ]);
          if (timer) clearTimeout(timer);
          if (timed.kind === "timeout") {
            out = {
              ok: false,
              reason: "DEMO_TIMEOUT",
              timeout_ms: timeoutMs,
              demo: true,
              DRY_RUN: true,
              no_signing: true,
              may_sign: false,
            };
          } else {
            out = timed.r;
          }
        }

        // Force response safety flags even if upstream decide shape changes.
        if (out && typeof out === "object") {
          out.demo = true;
          out.demo_mode = true;
          out.dry_run = true;
          out.DRY_RUN = true;
          out.no_signing = true;
          out.may_sign = false;
          out.portfolio_id = cfg.portfolioId;
          out.forced = {
            use_llm: true,
            dry_run: true,
            may_sign: false,
            portfolio_id: cfg.portfolioId,
            claimed_owner: cfg.claimedOwner,
          };
          if (out.enforcement && typeof out.enforcement === "object") {
            out.enforcement = { ...out.enforcement, may_sign: false };
          }
          if (out.summary && typeof out.summary === "object") {
            out.summary = { ...out.summary, may_sign: false };
          }
          // Strip any accidental secret-ish fields
          delete out.api_key;
          delete out.openrouter_api_key;
        }

        counted = Boolean(out?.ok);
      } catch (e) {
        out = {
          ok: false,
          reason: "DEMO_PIPELINE_ERROR",
          detail:
            e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
          demo: true,
          DRY_RUN: true,
          no_signing: true,
          may_sign: false,
        };
      } finally {
        restoreSpendCap();
        const spendAfter = getSpendState().usd;
        const delta = Math.max(0, spendAfter - spendBefore);
        const released = demoQuota.releaseFlight({
          clientKey,
          spendUsdDelta: delta,
          counted,
        });
        if (out && typeof out === "object") {
          out.demo_quota = released.ok
            ? released.status
            : { ok: false, reason: released.reason };
          out.latency_ms = Date.now() - started;
          out.client_key_hash = gate.client_key_hash;
        }
      }

      return out;
    },
  };
}

/**
 * Route dispatcher. Returns true if handled.
 */
export async function handleGateJRoute({
  method,
  path,
  body,
  json,
  req,
  res,
  handlers,
  meta = {},
}) {
  if (method === "GET" && path === "/gate-j/health") {
    let demo = null;
    try {
      demo = handlers.demoStatus?.() || null;
    } catch {
      demo = { ok: false, reason: "DEMO_QUOTA_UNAVAILABLE" };
    }
    json(req, res, 200, {
      ok: true,
      gate: "J",
      llm: getLlmConfig(),
      dry_run_default: true,
      funded_execution: false,
      mandate_hydration: "on_chain_required_for_live_llm",
      demo,
      demo_decide: "/v1/gate-j/demo-decide",
    });
    return true;
  }
  if (method === "GET" && path === "/gate-j/demo-status") {
    const st = handlers.demoStatus();
    json(req, res, st.ok ? 200 : 503, st);
    return true;
  }
  if (method === "POST" && path === "/gate-j/demo-decide") {
    const out = await handlers.demoDecide(body, meta);
    const status = out.ok
      ? 200
      : out.reason === "DEMO_QUOTA_UNAVAILABLE" ||
          out.reason === "DEMO_KILL_SWITCH" ||
          out.reason === "DEMO_DISABLED"
        ? 503
        : out.reason === "DEMO_BUSY" ||
            out.reason === "DEMO_CLIENT_COOLDOWN" ||
            out.reason === "DEMO_CLIENT_DAILY_LIMIT" ||
            out.reason === "DEMO_GLOBAL_DAILY_LIMIT" ||
            out.reason === "DEMO_SPEND_CAP"
          ? 429
          : out.reason === "DEMO_FORBIDDEN_FIELD"
            ? 403
            : 400;
    json(req, res, status, out);
    return true;
  }
  if (method === "GET" && path === "/gate-j/market") {
    json(req, res, 200, await handlers.market({}));
    return true;
  }
  if (method === "POST" && path === "/gate-j/market") {
    json(req, res, 200, await handlers.market(body));
    return true;
  }
  if (method === "GET" && path === "/gate-j/scenarios") {
    json(req, res, 200, handlers.scenarios());
    return true;
  }
  if (method === "POST" && path === "/gate-j/strategist") {
    const out = await handlers.decide(
      { ...body, critic_fixture: body.critic_fixture || "APPROVE" },
      meta
    );
    json(req, res, out.ok ? 200 : 400, { stage: "strategist+pipeline", ...out });
    return true;
  }
  if (method === "POST" && path === "/gate-j/fit") {
    const out = await handlers.decide(body, meta);
    json(req, res, out.ok ? 200 : 400, { stage: "fit", fitter: out.fitter, ...out });
    return true;
  }
  if (method === "POST" && path === "/gate-j/critic") {
    const out = await handlers.decide(body, meta);
    json(req, res, out.ok ? 200 : 400, { stage: "critic", critic: out.critic, ...out });
    return true;
  }
  if (method === "POST" && path === "/gate-j/decide") {
    const out = await handlers.decide(body, meta);
    json(req, res, out.ok ? 200 : 400, out);
    return true;
  }
  if (method === "GET" && path === "/gate-j/decisions") {
    json(req, res, 200, handlers.history());
    return true;
  }
  return false;
}
