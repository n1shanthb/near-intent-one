/**
 * Gate K HTTP handlers — AI dry-run / testnet execution / autonomous control.
 * Signing never available to unauthenticated callers.
 * Default: dry-run. First live trade requires operator_confirm + GATE_K_ALLOW_SIGN.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runGateKPipeline,
  createAutonomousLoop,
  MODE,
  FIRST_TEST,
  REASON,
} from "../gate-k/index.mjs";
import {
  hydrateMandateFromChain,
  revalidateMandate,
} from "../gate-j/hydrate.mjs";
import { verifyPortfolioBalances } from "../gate-j/balances.mjs";
import { rateLimitCheck, getLlmConfig, resetSpendState } from "../gate-j/index.mjs";

const TIDEPOOL = process.env.TIDEPOOL_URL || "https://www.usetidepool.tech";
const ORIGIN_ASSET =
  "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet";
const DEST_ASSET = "nep141:wnear.tidepool-sandbox.testnet";

async function defaultQuoteFn({ originAsset, destinationAsset, amount, deadlineMs }) {
  const agentRequest = {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: originAsset || ORIGIN_ASSET,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: destinationAsset || DEST_ASSET,
    amount: String(amount),
    refundTo: "0x0000000000000000000000000000000000000001",
    refundType: "ORIGIN_CHAIN",
    recipient: "0x0000000000000000000000000000000000000001",
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + (deadlineMs || 45 * 60 * 1000)).toISOString(),
  };
  const res = await fetch(`${TIDEPOOL}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(agentRequest),
  });
  const quote = await res.json();
  if (quote?.error) throw new Error(String(quote.error));
  return quote;
}

export function createGateKHandlers({
  store,
  evidenceDir,
  dataDir,
  viewFunction,
  fetchUsdcBalance,
  fetchEthBalance,
  fetchIntentsUsdc,
  getNearAccounts,
  attestor,
  eth,
  reconcilerHealth,
  quoteFn = defaultQuoteFn,
}) {
  mkdirSync(dataDir, { recursive: true });
  const historyPath = join(dataDir, "gate-k-decisions.json");

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

  const autoLoop = createAutonomousLoop({ store });

  async function resolveLiveMandate(body) {
    if (!body.portfolio_id) {
      return { ok: false, reason: "portfolio_id_required" };
    }
    if (!viewFunction) {
      return { ok: false, reason: "on_chain_view_unavailable" };
    }
    const portfolio = store.getPortfolio(body.portfolio_id);
    if (!portfolio) {
      return { ok: false, reason: "unknown_portfolio" };
    }
    if (body.portfolio_id !== FIRST_TEST.portfolio_id && process.env.GATE_K_ALLOW_OTHER_PORTFOLIOS !== "1") {
      return { ok: false, reason: REASON.WRONG_PORTFOLIO, required: FIRST_TEST.portfolio_id };
    }

    let balances = null;
    try {
      balances = await verifyPortfolioBalances({
        fetchSepoliaUsdcRaw: fetchUsdcBalance,
        fetchSepoliaEthWei: fetchEthBalance,
        fetchIntentsUsdc,
        intents_signer_id: portfolio.intents_signer_id,
        claimed_balance_usdc_raw: body.balance_usdc_raw || null,
      });
    } catch (e) {
      return {
        ok: false,
        reason: "BALANCE_VERIFY_FAILED",
        error: String(e?.message || e).slice(0, 200),
      };
    }
    if (!balances?.ok) {
      return { ok: false, reason: balances?.reason || "BALANCE_UNAVAILABLE", balances };
    }

    const hydrated = await hydrateMandateFromChain({
      view: (accountId, method, args) => viewFunction(accountId, method, args),
      portfolio,
      balance_usdc_raw: balances.balance_usdc_raw,
      claimed_owner: body.claimed_owner || null,
      clientMandate: body.mandate || null,
    });
    if (!hydrated.ok) return hydrated;

    return {
      ok: true,
      mandate: hydrated.mandate,
      portfolio,
      balances,
      revalidate_key: hydrated.mandate?.revalidate_key,
    };
  }

  return {
    health() {
      const recon = reconcilerHealth?.() || { ok: false };
      return {
        ok: true,
        gate: "K",
        network: "sepolia_testnet_only",
        modes: MODE,
        first_test: FIRST_TEST,
        autonomous_loop_env: process.env.GATE_K_AUTONOMOUS_LOOP === "1",
        allow_sign_env: process.env.GATE_K_ALLOW_SIGN === "1",
        reconciler: recon,
        dry_run_default: true,
        note: "Gate K PASS requires one reconciled AI-directed testnet trade",
      };
    },

    async decide(body = {}, meta = {}) {
      const mode =
        body.mode === MODE.TESTNET_EXECUTION || body.mode === "execute"
          ? MODE.TESTNET_EXECUTION
          : body.mode === MODE.AUTONOMOUS || body.mode === "autonomous"
            ? MODE.AUTONOMOUS
            : MODE.DRY_RUN;

      const authenticated = meta.authenticated === true;
      if (mode !== MODE.DRY_RUN && !authenticated) {
        return {
          ok: false,
          reason: REASON.UNAUTHENTICATED,
          hint: "API key required for AI_TESTNET_EXECUTION",
        };
      }

      if (body.use_llm === true) {
        const rl = rateLimitCheck({
          key: `gate-k-llm:${meta.apiKeyHash || meta.ip || "anon"}`,
        });
        if (!rl.ok) return { ok: false, ...rl };
        const cfg = getLlmConfig();
        if (!cfg.configured || cfg.provider !== "openrouter") {
          return { ok: false, reason: "OPENROUTER_REQUIRED" };
        }
        resetSpendState();
      }

      const resolved = await resolveLiveMandate(body);
      if (!resolved.ok) return resolved;

      const { mandate, portfolio, balances } = resolved;
      const recon = reconcilerHealth?.() || { ok: false };

      const confirmSpend = Number(body.confirm_max_spend_usdc);
      const operatorConfirm =
        body.operator_confirm === true &&
        body.confirm_first_ai_trade === true &&
        confirmSpend === FIRST_TEST.max_trade_usdc;

      const executeDeps =
        mode !== MODE.DRY_RUN && getNearAccounts && attestor && eth
          ? {
              store,
              getNearAccounts,
              viewFunction,
              attestor,
              eth,
            }
          : null;

      const trace = await runGateKPipeline({
        mandate,
        portfolio,
        portfolioId: body.portfolio_id,
        balances: {
          usdc_raw: balances.balance_usdc_raw,
          source: balances.source,
        },
        useLlm: body.use_llm === true,
        mode,
        operatorConfirm,
        authenticated,
        reconcilerOk: !!recon.ok,
        store,
        viewFunction,
        quoteFn: mode === MODE.DRY_RUN && body.skip_quote ? null : quoteFn,
        executeDeps,
        fixtureProposal: body.use_llm ? null : body.proposal || null,
        marketFixture: body.market_fixture || null,
        criticFixture: body.use_llm ? null : body.critic_fixture || null,
      });

      // Persist decision (no secrets)
      const row = {
        at: new Date().toISOString(),
        portfolio_id: body.portfolio_id,
        mode,
        decision: trace.enforcement?.decision,
        reason_codes: trace.enforcement?.reason_codes,
        signing: !!trace.signing,
        preview: trace.preview || null,
        models: trace.gate_j?.summary?.models || null,
      };
      const hist = loadHistory();
      hist.push(row);
      saveHistory(hist);
      store.recordDecision({
        portfolio_id: body.portfolio_id,
        kind: "gate_k",
        ...row,
      });

      try {
        writeFileSync(
          join(evidenceDir, "gate-k-last-decision.json"),
          JSON.stringify(
            {
              ...row,
              gate_j_summary: trace.gate_j?.summary,
              economics: trace.economics,
              safety: trace.safety
                ? { ok: trace.safety.ok, reason: trace.safety.reason }
                : null,
              execution: trace.execution
                ? {
                    ok: trace.execution.ok,
                    signed: trace.execution.signed,
                    reason: trace.execution.reason,
                    operation_id: trace.execution.execution?.operation_id,
                    propose_tx: trace.execution.execution?.propose_tx,
                    sign_tx: trace.execution.execution?.sign_tx,
                  }
                : null,
            },
            null,
            2
          )
        );
      } catch {
        /* optional */
      }

      return {
        ok: true,
        gate: "K",
        ...trace,
        pass: false,
        pass_note:
          "Gate K PASS only after one AI-directed trade executes and reconciles independently",
      };
    },

    async prepare(body = {}, meta = {}) {
      // Force dry-run prepare path with live quote for operator preview
      return this.decide(
        {
          ...body,
          mode: MODE.DRY_RUN,
          use_llm: body.use_llm !== false,
          skip_quote: false,
        },
        meta
      );
    },

    decisions() {
      return { ok: true, decisions: loadHistory() };
    },

    autonomousStart(body = {}, meta = {}) {
      if (!meta.authenticated) {
        return { ok: false, reason: REASON.UNAUTHENTICATED };
      }
      return autoLoop.start(body.portfolio_id || FIRST_TEST.portfolio_id, body);
    },
    autonomousStop(body = {}, meta = {}) {
      if (!meta.authenticated) {
        return { ok: false, reason: REASON.UNAUTHENTICATED };
      }
      return autoLoop.stop(body.portfolio_id || FIRST_TEST.portfolio_id);
    },
    autonomousStatus(body = {}) {
      return {
        ok: true,
        ...autoLoop.status(body.portfolio_id || FIRST_TEST.portfolio_id),
        pending: autoLoop.recoverPending(),
      };
    },

    recoverPending() {
      return { ok: true, pending: autoLoop.recoverPending() };
    },
  };
}

export async function handleGateKRoute({
  method,
  path,
  body,
  json,
  req,
  res,
  handlers,
  meta,
}) {
  if (method === "GET" && path === "/gate-k/health") {
    json(req, res, 200, handlers.health());
    return true;
  }
  if (method === "GET" && path === "/gate-k/decisions") {
    json(req, res, 200, handlers.decisions());
    return true;
  }
  if (method === "GET" && path === "/gate-k/autonomous") {
    json(req, res, 200, handlers.autonomousStatus(body || {}));
    return true;
  }
  if (method === "GET" && path === "/gate-k/pending") {
    json(req, res, 200, handlers.recoverPending());
    return true;
  }
  if (method === "POST" && path === "/gate-k/prepare") {
    json(req, res, 200, await handlers.prepare(body, meta));
    return true;
  }
  if (method === "POST" && path === "/gate-k/decide") {
    json(req, res, 200, await handlers.decide(body, meta));
    return true;
  }
  if (method === "POST" && path === "/gate-k/autonomous/start") {
    json(req, res, 200, handlers.autonomousStart(body, meta));
    return true;
  }
  if (method === "POST" && path === "/gate-k/autonomous/stop") {
    json(req, res, 200, handlers.autonomousStop(body, meta));
    return true;
  }
  return false;
}
