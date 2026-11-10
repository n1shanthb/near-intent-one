#!/usr/bin/env node
/**
 * Gate K — prepare first 1 USDC AI-directed testnet trade (DRY RUN / preview only).
 * NEVER broadcasts. NEVER sets GATE_K_ALLOW_SIGN.
 *
 * Usage:
 *   node scripts/gate-k-prepare.mjs
 *   node scripts/gate-k-prepare.mjs --live-llm
 *   node scripts/gate-k-prepare.mjs --api http://127.0.0.1:8787/v1
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadServicesEnv } from "../packages/gate-j/llm.mjs";
import { runGateKPipeline, MODE, FIRST_TEST } from "../packages/gate-k/index.mjs";
import { hydrateMandateFromChain } from "../packages/gate-j/hydrate.mjs";
import { verifyPortfolioBalances } from "../packages/gate-j/balances.mjs";
import { baseStrategistProposal, freshMarket } from "../packages/gate-j/fixtures.mjs";
import { openStore } from "../packages/services/store.mjs";
import {
  pickRpc,
  viewFunction,
  erc20Balance,
  ethBalance,
  intentsMtBalance,
  USDC_SEPOLIA,
} from "./lib/near-live.mjs";

loadServicesEnv();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = join(ROOT, "evidence", "live");
const DATA = process.env.GATE_I_DATA_DIR || join(ROOT, ".gate-i-data");
const args = process.argv.slice(2);
const useLlm = args.includes("--live-llm");
const apiIdx = args.indexOf("--api");
const apiBase = apiIdx >= 0 ? args[apiIdx + 1] : null;

mkdirSync(EVIDENCE, { recursive: true });

function loadProvisionPortfolio() {
  const p = join(EVIDENCE, "gate-i-provision.json");
  if (!existsSync(p)) return null;
  const provision = JSON.parse(readFileSync(p, "utf8"));
  const u = (provision.users || []).find((x) => x.portfolio_id === FIRST_TEST.portfolio_id);
  return u
    ? {
        portfolio_id: u.portfolio_id,
        owner_account: u.owner,
        policy_contract: u.policy,
        agent_account: u.agent,
        reconciler_account: u.reconciler,
        intents_signer_id: u.evm,
        derivation_path: u.derivation_path,
      }
    : null;
}

async function prepareLocal() {
  const store = openStore(DATA);
  let portfolio = store.getPortfolio(FIRST_TEST.portfolio_id) || loadProvisionPortfolio();
  if (portfolio && !store.getPortfolio(FIRST_TEST.portfolio_id)) {
    store.upsertPortfolio(FIRST_TEST.portfolio_id, portfolio);
  }
  if (!portfolio) {
    console.error(
      JSON.stringify({
        ok: false,
        reason: "portfolio_i-a-a4e7_not_found",
        hint: "Run gate-i:provision or sync evidence/live/gate-i-provision.json",
      })
    );
    process.exit(1);
  }

  const rpc = await pickRpc();
  const view = (accountId, method, args = {}) =>
    viewFunction(rpc, accountId, method, args);

  const balances = await verifyPortfolioBalances({
    fetchSepoliaUsdcRaw: async (evm) =>
      String((await erc20Balance(USDC_SEPOLIA, evm)) ?? "0"),
    fetchSepoliaEthWei: async (evm) => String(await ethBalance(evm)),
    fetchIntentsUsdc: async (evm) => intentsMtBalance(rpc, evm),
    intents_signer_id: portfolio.intents_signer_id,
  });
  if (!balances.ok) {
    console.error(JSON.stringify({ ok: false, stage: "balances", ...balances }, null, 2));
    process.exit(1);
  }

  const hydrated = await hydrateMandateFromChain({
    view,
    portfolio,
    balance_usdc_raw: balances.balance_usdc_raw,
  });
  if (!hydrated.ok) {
    console.error(JSON.stringify({ ok: false, stage: "hydrate", ...hydrated }, null, 2));
    process.exit(1);
  }

  const TIDEPOOL = process.env.TIDEPOOL_URL || "https://www.usetidepool.tech";
  const quoteFn = async ({ originAsset, destinationAsset, amount, deadlineMs }) => {
    const agentRequest = {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset,
      amount: String(amount),
      refundTo: portfolio.intents_signer_id,
      refundType: "ORIGIN_CHAIN",
      recipient: portfolio.intents_signer_id,
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
    // Return Tidepool envelope as-is; gate-k/quote.mjs normalizes fields.
    return quote;
  };

  // Without --live-llm: use a viable fixture so the 1 USDC safety+quote preview is exercised.
  // With --live-llm: real OpenRouter path (may still return NO_TRADE if uneconomic).
  const fixtureProposal = useLlm
    ? null
    : baseStrategistProposal({
        proposed_size_usd: 1,
        min_viable_size_usd: 0.5,
        edge_bps: 100,
        fee_bps: 10,
        price_impact_bps: 5,
        max_slippage_bps: 20,
      });

  const trace = await runGateKPipeline({
    mandate: hydrated.mandate,
    portfolio,
    portfolioId: FIRST_TEST.portfolio_id,
    balances: { usdc_raw: balances.balance_usdc_raw },
    useLlm,
    mode: MODE.DRY_RUN,
    authenticated: false,
    reconcilerOk: false,
    store,
    viewFunction: view,
    quoteFn,
    fixtureProposal,
    marketFixture: useLlm ? null : freshMarket({ near_usd: 5, usdc_usd: 1 }),
    criticFixture: useLlm ? null : "APPROVE",
  });

  const out = {
    ok: true,
    gate: "K",
    mode: MODE.DRY_RUN,
    portfolio_id: FIRST_TEST.portfolio_id,
    owner_account: hydrated.mandate.owner_account,
    policy_contract: portfolio.policy_contract,
    mandate_epoch: hydrated.mandate.mandate_epoch,
    policy_hash: hydrated.mandate.policy_hash,
    autonomous_trading: hydrated.mandate.autonomous_trading,
    balance_usdc_raw: balances.balance_usdc_raw,
    decision: trace.enforcement?.decision,
    reason_codes: trace.enforcement?.reason_codes,
    preview: trace.preview,
    quote: trace.quote
      ? {
          ok: trace.quote.ok,
          reason: trace.quote.reason,
          quote_hash: trace.quote.quote?.quote_hash,
          amount_out: trace.quote.quote?.amount_out,
          deposit_address: trace.quote.quote?.deposit_address,
        }
      : null,
    economics: trace.economics,
    economics_quoted: trace.economics_quoted || null,
    safety: trace.safety
      ? {
          ok: trace.safety.ok,
          reason: trace.safety.reason,
          size: trace.safety.safe_proposal?.proposed_size_usdc_raw,
        }
      : null,
    models: trace.gate_j?.summary?.models || null,
    signing: false,
    broadcast: false,
    next_steps: {
      owner_authorization:
        "Owner must approve/set on-chain mandate via wallet/Ledger path (set_policy / set_autonomous_trading). Browser claimed_owner is not authorization.",
      first_live_command:
        "After explicit approval: set GATE_K_ALLOW_SIGN=1 and POST /v1/gate-k/decide with mode=AI_TESTNET_EXECUTION, operator_confirm=true, confirm_first_ai_trade=true, confirm_max_spend_usdc=26, use_llm=true, portfolio_id=i-a-a4e7 + API key",
      stop: "This prepare script does NOT broadcast. Await operator approval.",
    },
    pass: false,
  };

  const path = join(EVIDENCE, "gate-k-prepare-preview.json");
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.error(`\nWrote ${path}`);
  console.error("\n*** STOP — no transaction broadcast. Awaiting your explicit approval for the first live AI trade. ***\n");
}

async function prepareViaApi(base) {
  const key = process.env.GATE_I_API_KEY || "";
  const res = await fetch(`${base.replace(/\/$/, "")}/gate-k/prepare`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: JSON.stringify({
      portfolio_id: FIRST_TEST.portfolio_id,
      use_llm: useLlm,
    }),
  });
  const body = await res.json();
  writeFileSync(
    join(EVIDENCE, "gate-k-prepare-preview.json"),
    JSON.stringify(body, null, 2)
  );
  console.log(JSON.stringify(body, null, 2));
  console.error("\n*** STOP — no transaction broadcast. Awaiting your explicit approval. ***\n");
}

if (apiBase) {
  await prepareViaApi(apiBase);
} else {
  await prepareLocal();
}
