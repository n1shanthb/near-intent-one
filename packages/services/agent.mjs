/**
 * Gate I3 — hosted agent loop (per-portfolio scheduling).
 * Uses valuation fail-closed checks. Never holds Ledger/demo owner keys.
 * Never re-enables software signing bypass for nio-c-* accounts.
 */
import { decide } from "../strategy/decide.mjs";
import { checkTradeWithinUsdLimit } from "../valuation/units.mjs";

const AMOUNT_DEFAULT = "1000000";
const GAS_LIMIT = 250000n;
const MAX_GAS_PRICE = 5_000_000_000n;
const CHAIN_ID = 11155111;
const DEMO_PREFIX = "nio-c-";
const ORIGIN_ASSET =
  "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet";
const DEST_ASSET = "nep141:wnear.tidepool-sandbox.testnet";
const TIDEPOOL = process.env.TIDEPOOL_URL || "https://www.usetidepool.tech";
const USDC_SEPOLIA = "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2";

export function createAgentService({
  store,
  getNearAccounts,
  viewFunction,
  attestor,
  eth,
  logger = console,
}) {
  const timers = new Map();

  async function tick(portfolioId) {
    const p = store.getPortfolio(portfolioId);
    if (!p || !p.running) return;
    if (String(p.policy_contract || "").startsWith(DEMO_PREFIX)) {
      logger.error?.("[agent] refusing demo Ledger portfolio");
      return;
    }

    const { agent } = await getNearAccounts(p);
    const snap = await viewFunction(p.policy_contract, "get_exposure_snapshot");
    const amount = p.trade_amount || AMOUNT_DEFAULT;
    const evm = p.intents_signer_id;

    const valuation = checkTradeWithinUsdLimit({
      assetIn: ORIGIN_ASSET,
      amountInRaw: amount,
      maxTradeValueRaw: p.max_trade_value || "100000000",
    });
    if (!valuation.ok) {
      const decision = {
        choice: "NO_TRADE",
        rationale: valuation.reason,
        timestamp: new Date().toISOString(),
        rejection_code: "VALUATION_FAIL_CLOSED",
        valuation,
      };
      store.recordDecision({ portfolio_id: portfolioId, ...decision });
      store.upsertPortfolio(portfolioId, { last_decision: decision });
      return;
    }

    const agentRequest = {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ORIGIN_ASSET,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: DEST_ASSET,
      amount,
      refundTo: evm,
      refundType: "ORIGIN_CHAIN",
      recipient: evm,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    };

    let quote = null;
    try {
      const quoteHttp = await fetch(`${TIDEPOOL}/v0/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(agentRequest),
      });
      quote = await quoteHttp.json();
    } catch (e) {
      quote = { error: String(e.message || e) };
    }

    const decision = decide({
      exposure: snap,
      quote,
      request: agentRequest,
      constraints: {
        trade_amount: amount,
        max_pending_exposure: p.max_pending_exposure || "100000000",
        min_amount_out_floor: "1",
        revoked: !!snap.revoked,
        strategy_id: p.strategy_id || "origin-usdc-to-wnear-v1",
        enforce_relative_rate: false,
      },
    });
    decision.valuation = valuation;
    store.recordDecision({ portfolio_id: portfolioId, ...decision });
    store.upsertPortfolio(portfolioId, { last_decision: decision });

    if (decision.choice !== "TRADE") return;

    const execKey = `trade:${portfolioId}:${decision.timestamp}`;
    const inflight = store.beginExecution(execKey, {
      kind: "trade",
      portfolio_id: portfolioId,
    });
    if (inflight.status === "SUCCESS") return;

    try {
      const attest = attestor.attest({
        quoteResponse: quote,
        agentRequest,
        tokenContract: USDC_SEPOLIA,
        chainId: CHAIN_ID,
        maxGasPrice: MAX_GAS_PRICE.toString(),
        gasLimit: GAS_LIMIT.toString(),
      });
      if (!attest.ok) {
        store.finishExecution(execKey, {
          status: "FAILED",
          reason: "attestor_rejected",
          checks: attest.checks,
        });
        return;
      }

      const epoch = await viewFunction(p.policy_contract, "get_mandate_epoch");
      const nonceObserved = BigInt(
        (await eth("eth_getTransactionCount", [evm, "pending"])).result
      );
      const nonce = BigInt(store.nextNonce(evm, nonceObserved.toString())) - 1n;
      let gasPrice = BigInt((await eth("eth_gasPrice", [])).result || "0");
      if (gasPrice < 1_000_000_000n) gasPrice = 1_000_000_000n;
      gasPrice = (gasPrice * 120n) / 100n;
      if (gasPrice > MAX_GAS_PRICE) gasPrice = MAX_GAS_PRICE;

      const opId = `i-agent-${Date.now()}`;
      const propose = await agent.functionCall({
        contractId: p.policy_contract,
        methodName: "propose_quoted_evm_transfer",
        args: {
          operation_id: opId,
          attestation: attest.attestation,
          attestation_signature: attest.signature,
          signer_public_key: attest.publicKey,
          tx: {
            nonce: nonce.toString(),
            gas_price: gasPrice.toString(),
            gas_limit: GAS_LIMIT.toString(),
            chain_id: String(CHAIN_ID),
            token_contract: USDC_SEPOLIA.toLowerCase(),
            to: attest.attestation.deposit_address,
            amount: amount,
          },
          expected_epoch: epoch,
        },
        gas: BigInt("100000000000000"),
        attachedDeposit: 0n,
      });

      const sign = await agent.functionCall({
        contractId: p.policy_contract,
        methodName: "request_signature",
        args: { operation_id: opId },
        gas: BigInt("300000000000000"),
        attachedDeposit: 1n,
      });

      store.finishExecution(execKey, {
        status: "SIGNED_PENDING_BROADCAST",
        operation_id: opId,
        propose_tx: propose.transaction.hash,
        sign_tx: sign.transaction.hash,
        nonce: nonce.toString(),
      });
      store.upsertPortfolio(portfolioId, {
        last_settlement: {
          operation_id: opId,
          status: "SIGNED_PENDING_BROADCAST",
          near_tx: sign.transaction.hash,
        },
      });
    } catch (e) {
      store.finishExecution(execKey, {
        status: "FAILED",
        reason: String(e.message || e).slice(0, 500),
      });
      logger.error?.(`[agent] tick failed ${portfolioId}: ${e.message || e}`);
    }
  }

  return {
    health() {
      return {
        ok: true,
        role: "agent",
        running: [...timers.keys()],
      };
    },
    start(portfolioId, opts = {}) {
      const p = store.getPortfolio(portfolioId);
      if (!p) return { ok: false, reason: "unknown_portfolio" };
      if (String(p.policy_contract || "").startsWith(DEMO_PREFIX)) {
        return { ok: false, reason: "demo_ledger_portfolio_forbidden" };
      }
      store.upsertPortfolio(portfolioId, {
        running: true,
        strategy_id: opts.strategy_id || p.strategy_id || "origin-usdc-to-wnear-v1",
        trade_amount: opts.trade_amount || p.trade_amount || AMOUNT_DEFAULT,
      });
      if (timers.has(portfolioId)) clearInterval(timers.get(portfolioId));
      const ms = opts.interval_ms || 60_000;
      const handle = setInterval(() => {
        tick(portfolioId).catch((e) => logger.error?.(String(e)));
      }, ms);
      timers.set(portfolioId, handle);
      // immediate tick
      tick(portfolioId).catch((e) => logger.error?.(String(e)));
      return { ok: true };
    },
    stop(portfolioId) {
      if (timers.has(portfolioId)) {
        clearInterval(timers.get(portfolioId));
        timers.delete(portfolioId);
      }
      store.upsertPortfolio(portfolioId, { running: false });
      return { ok: true };
    },
    state(portfolioId) {
      const p = store.getPortfolio(portfolioId) || {};
      return {
        portfolio_id: portfolioId,
        running: !!p.running && timers.has(portfolioId),
        strategy_id: p.strategy_id || null,
        last_decision: p.last_decision || null,
        last_settlement: p.last_settlement || null,
        source: "live_gate_i",
      };
    },
    /** Recover in-flight executions after process restart */
    recoverPending() {
      const s = store.read();
      const pending = Object.entries(s.executions || {}).filter(
        ([, v]) => v.status === "IN_FLIGHT" || v.status === "SIGNED_PENDING_BROADCAST"
      );
      return pending.map(([key, meta]) => ({ key, ...meta }));
    },
  };
}
