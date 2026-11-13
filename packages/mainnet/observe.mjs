/**
 * Mainnet read-only observation — balances, routes, AI decisions.
 * Observation-only: never broadcasts, never unpauses, never funds.
 */
import { MAINNET } from "../networks/profiles.mjs";
import { pickRpc, viewFunction, viewAccount } from "../networks/rpc.mjs";
import { deriveMainnetEvmAddress } from "./mpc.mjs";
import { runFourChainQuoteMatrix } from "./multichainRouter.mjs";
import { fetchFourChainEvmBalances } from "./evmBalances.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";
import { mainnetExecutionGates } from "./safetyGates.mjs";
import { finalEnforce } from "../gate-j/enforce.mjs";
import { runGateJPipeline } from "../gate-j/pipeline.mjs";
import { loadServicesEnv, getLlmConfig } from "../gate-j/llm.mjs";
import { NIO_CHAINS } from "./tokenCatalog.mjs";

export { NIO_CHAINS };

/**
 * Build a Gate-J mandate object from live policy views (paused stays paused).
 */
export async function loadMainnetMandateFromChain(rpc, ids = MAINNET_IDENTITIES) {
  const [
    owner,
    agent,
    paused,
    autonomous,
    epoch,
    limits,
    intentsSigner,
    derivationPath,
  ] = await Promise.all([
    viewFunction(rpc, ids.policy, "get_owner", {}),
    viewFunction(rpc, ids.policy, "get_agent", {}),
    viewFunction(rpc, ids.policy, "get_paused", {}),
    viewFunction(rpc, ids.policy, "get_autonomous_trading", {}),
    viewFunction(rpc, ids.policy, "get_mandate_epoch", {}),
    viewFunction(rpc, ids.policy, "get_limits", {}),
    viewFunction(rpc, ids.policy, "get_intents_signer_id", {}).catch(() => null),
    viewFunction(rpc, ids.policy, "get_derivation_path", {}).catch(() => ids.derivation_path),
  ]);

  return {
    owner_account: owner,
    agent_account: agent,
    policy_contract: ids.policy,
    paused: Boolean(paused),
    autonomous_trading: Boolean(autonomous),
    mandate_epoch: epoch,
    revoked: false,
    signing_revoked: false,
    limits: limits || {},
    allowed_assets: limits?.allowed_assets || ["USDC", "WETH", "wNEAR", "NEAR"],
    allowed_networks: ["near", "ethereum", "arbitrum", "base"],
    allowed_destinations: limits?.allowed_destinations || [],
    per_trade_limit_usd: Number(limits?.max_notional_usd || limits?.per_trade_limit_usd || 0) || 0,
    balance_usd: 0,
    intents_signer_id: intentsSigner,
    derivation_path: derivationPath || ids.derivation_path,
    portfolio_id: ids.portfolio_id,
  };
}

/**
 * Full observation snapshot for the read-only mainnet API.
 */
export async function runMainnetObservation(opts = {}) {
  loadServicesEnv();
  const ids = { ...MAINNET_IDENTITIES, ...(opts.identities || {}) };
  const env = opts.env || process.env;
  const rpc = opts.rpc || (await pickRpc(MAINNET.near.rpcs));
  const gates = mainnetExecutionGates(env);

  const agentView = await viewAccount(rpc, ids.agent);
  const agentNear = {
    account_id: ids.agent,
    exists: true,
    amount_yocto: agentView.amount,
    locked_yocto: agentView.locked,
    amount_near: Number(BigInt(agentView.amount)) / 1e24,
    available_near:
      Number(BigInt(agentView.amount) - BigInt(agentView.locked || "0")) / 1e24,
  };

  const mandate = await loadMainnetMandateFromChain(rpc, ids);

  let mpc;
  try {
    mpc = await deriveMainnetEvmAddress({
      policyContract: ids.policy,
      portfolioId: ids.portfolio_id,
      path: ids.derivation_path,
      rpc,
    });
  } catch (e) {
    mpc = { ok: false, reason: String(e.message || e) };
  }

  const expectedMpc = ids.mpc_evm_address.toLowerCase();
  const mpcMatch =
    mpc?.evm_address && mpc.evm_address.toLowerCase() === expectedMpc;

  const evmBalances = mpc?.evm_address
    ? await fetchFourChainEvmBalances(mpc.evm_address, opts)
    : { ok: false, reason: "no_mpc_address" };

  // Attach verified capital keyed by canonical asset ids after a quick catalog pass
  let quoteMatrix;
  try {
    const balanceMap = {};
    // Use actual USDC contract asset ids from matrix canonical resolution inside runner;
    // capitalAvailable looks up by asset_id from catalog — pass verified zeros on those ids
    // via opts.balances after first resolving catalog in runFourChainQuoteMatrix.
    const evmAddr = mpc?.evm_address || ids.mpc_evm_address;
    quoteMatrix = await runFourChainQuoteMatrix({
      recipient: evmAddr,
      refundTo: evmAddr,
      evmRecipient: evmAddr,
      evmRefund: evmAddr,
      nearRecipient: ids.owner,
      nearRefund: ids.owner,
      amount: "1000000", // 1 USDC discovery size — dry quote only
      balances: {}, // empty → capital fails → NO_TRADE (honest: unfunded)
      mandate: {
        paused: mandate.paused,
        max_notional_usd: mandate.per_trade_limit_usd,
        allowed_destinations: mandate.allowed_destinations,
      },
    });
  } catch (e) {
    quoteMatrix = {
      ok: false,
      reason: "quote_matrix_failed",
      detail: String(e.message || e).slice(0, 300),
    };
  }

  // Policy pause → enforce NO_TRADE regardless of discovery quotes
  const enforce = finalEnforce({
    proposal: quoteMatrix?.proposal || { choice: "NO_TRADE" },
    mandate,
    market: { stale: false },
    fitResult: { outcome: "REJECTED", reason_codes: ["OBSERVE_ONLY"] },
    criticReview: { verdict: "REJECT", rationale: "observe_only_paused_policy" },
    dryRun: true,
    allowExecute: false,
  });

  // Genuine multi-model path when OpenRouter configured; else deterministic fixtures.
  // Live 1Click matrix is injected into market so strategist cannot silently use mocks only.
  let gateJ = null;
  const llm = getLlmConfig();
  const liveQuoteMarket = {
    as_of: new Date().toISOString(),
    stale: false,
    sources: ["1click.chaindefuser.com/v0/quote", "on_chain_balances"],
    live_1click: {
      ok: Boolean(quoteMatrix?.ok),
      dry: true,
      quoted_count: quoteMatrix?.quoted_count ?? 0,
      eligible_count: quoteMatrix?.eligible_count ?? 0,
      proposal: quoteMatrix?.proposal || null,
      top_discovery: (quoteMatrix?.matrix || [])
        .filter((r) => r.ok && r.amount_out_usd != null)
        .sort((a, b) => (b.amount_out_usd || 0) - (a.amount_out_usd || 0))
        .slice(0, 5)
        .map((r) => ({
          id: r.id || r.route?.id,
          label: r.label || r.route?.label,
          amount_out_usd: r.amount_out_usd,
          amount_out: r.amount_out,
        })),
      note: "Dry quotes only — not funding authorization",
    },
    verified_balances: {
      near_available: agentNear.available_near,
      evm_usdc: evmBalances?.chains
        ? Object.fromEntries(
            Object.entries(evmBalances.chains).map(([k, v]) => [k, v.usdc_ui])
          )
        : {},
    },
  };
  try {
    gateJ = await runGateJPipeline({
      mandate: {
        ...mandate,
        balance_usd: 0,
        usdc_balance_raw: "0",
      },
      balances: {
        usdc_raw: "0",
        eth_wei: "0",
        verified: true,
      },
      marketFixture: liveQuoteMarket,
      useLlm: Boolean(llm.configured),
      dryRun: true,
      allowExecute: false,
      fixtureProposal: llm.configured
        ? null
        : {
            choice: "NO_TRADE",
            rationale:
              "llm_not_configured — live_1click matrix recorded but strategist fixture NO_TRADE",
            live_quotes_seen: Boolean(quoteMatrix?.ok),
            quoted_count: quoteMatrix?.quoted_count ?? 0,
          },
      criticFixture: llm.configured ? null : "REJECT",
    });
  } catch (e) {
    gateJ = {
      ok: false,
      reason: "gate_j_observe_failed",
      detail: String(e.message || e).slice(0, 300),
      enforcement: { decision: "NO_TRADE", may_sign: false },
    };
  }

  const decision = {
    choice:
      mandate.paused || enforce.decision === "NO_TRADE"
        ? "NO_TRADE"
        : gateJ?.enforcement?.decision ||
          quoteMatrix?.proposal?.choice ||
          "NO_TRADE",
    vetoes: [
      mandate.paused ? "POLICY_PAUSED" : null,
      gates.funded_trading ? null : "FUNDED_TRADING_OFF",
      gates.mainnet_broadcast_enabled ? null : "BROADCAST_DISABLED",
      gates.autonomous_execution_enabled ? null : "AUTONOMOUS_OFF",
      evmBalances?.any_usdc ? null : "NO_VERIFIED_EVM_USDC",
      mpcMatch ? null : "MPC_ADDRESS_MISMATCH",
      quoteMatrix?.ok ? null : "QUOTE_DISCOVERY_UNAVAILABLE",
    ].filter(Boolean),
    route_discovery: quoteMatrix?.proposal || null,
    quote_discovery_ok: Boolean(quoteMatrix?.ok),
    quote_discovery_reason: quoteMatrix?.reason || null,
    gate_j_decision: gateJ?.enforcement?.decision || null,
    gate_j_reason_codes: gateJ?.enforcement?.reason_codes || [],
    may_sign: false,
    may_broadcast: false,
    observation_only: true,
  };

  return {
    ok: true,
    network: "mainnet",
    observation_only: true,
    at: new Date().toISOString(),
    identities: {
      owner: ids.owner,
      policy: ids.policy,
      agent: ids.agent,
      portfolio_id: ids.portfolio_id,
    },
    agent: agentNear,
    policy: {
      paused: mandate.paused,
      autonomous_trading: mandate.autonomous_trading,
      mandate_epoch: mandate.mandate_epoch,
      owner: mandate.owner_account,
      agent: mandate.agent_account,
      allowed_destinations: mandate.allowed_destinations,
      allowed_networks: mandate.allowed_networks,
      derivation_path: mandate.derivation_path,
      intents_signer_id: mandate.intents_signer_id,
    },
    chains: Object.values(NIO_CHAINS).map((c) => ({
      id: c.id,
      display: c.display,
      eip155: c.eip155,
    })),
    mpc: {
      path: mpc?.path || ids.derivation_path,
      evm_address: mpc?.evm_address || null,
      expected_evm_address: expectedMpc,
      match: Boolean(mpcMatch),
      status: mpc?.status || "FAILED",
      signer: ids.mpc_signer,
    },
    balances: {
      near: agentNear,
      evm: evmBalances,
    },
    quotes: quoteMatrix,
    decision,
    enforcement: {
      decision: enforce.decision,
      reason_codes: enforce.reason_codes,
      may_sign: enforce.may_sign,
    },
    gate_j: {
      llm_configured: llm.configured,
      llm_models: llm.models,
      enforcement: gateJ?.enforcement || null,
      strategist_choice: gateJ?.strategist?.proposal?.choice || gateJ?.strategist?.choice || null,
      researcher_ok: gateJ?.researcher?.ok ?? null,
      critic: gateJ?.critic?.verdict || gateJ?.critic?.review?.verdict || null,
    },
    gates: {
      funded_trading: gates.funded_trading,
      mainnet_broadcast_enabled: gates.mainnet_broadcast_enabled,
      autonomous_execution_enabled: gates.autonomous_execution_enabled,
    },
  };
}
