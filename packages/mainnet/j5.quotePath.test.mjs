/**
 * Checkpoint J5 — quote verification + attestation + ERC-20 path (no broadcast).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import {
  verifySignedOneClickQuote,
  buildLocallySignedQuoteResponse,
  mutateQuoteResponse,
  ONE_CLICK_MANAGER_PUB_KEY,
} from "../intents-codec/oneClickVerify.mjs";
import { attestTidepoolQuote } from "../intents-codec/quote-auth.mjs";
import {
  ASSETS,
  MPC_EVM,
  MAINNET_EPOCH,
  runLocalQuoteAuthorizationPath,
  simulatePolicyChecks,
  buildErc20TxParams,
  evaluateLiveMinOutAgainstPolicy,
} from "./quotePath.mjs";
import { buildDecimalsRiskReport, analyzeDecimalsRisk } from "./decimalsRisk.mjs";
import {
  buildLiveQuoteMarketFragment,
  assertQuoteLevelConsumed,
  extractQuoteEconomics,
} from "./quoteEconomics.mjs";
import { productionDryQuote } from "./intents.mjs";

const ESCROW = "0x1111111111111111111111111111111111111111";
const OWNER_EVM = MPC_EVM;
const OWNER_NEAR = "nishanthb.near";

describe("J5 oneClick signed-quote verification", () => {
  it("accepts locally signed quote bound to request", () => {
    const kp = nacl.sign.keyPair();
    const quoteRequest = {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ASSETS.eth_usdc.asset_id,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: ASSETS.wrap_near.asset_id,
      amount: "1000000",
      refundTo: OWNER_EVM,
      refundType: "ORIGIN_CHAIN",
      recipient: OWNER_NEAR,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 600_000).toISOString(),
    };
    const quote = {
      amountIn: "1000000",
      amountInFormatted: "1",
      amountInUsd: "1",
      minAmountIn: "1000000",
      amountOut: "300000000000000000000000",
      amountOutFormatted: "0.3",
      amountOutUsd: "0.99",
      minAmountOut: "297000000000000000000000",
      depositAddress: ESCROW,
      deadline: quoteRequest.deadline,
    };
    const signed = buildLocallySignedQuoteResponse({
      quoteRequest,
      quote,
      secretKey64: Buffer.from(kp.secretKey),
    });
    const v = verifySignedOneClickQuote(signed, {
      agentRequest: {
        originAsset: quoteRequest.originAsset,
        destinationAsset: quoteRequest.destinationAsset,
        amount: quoteRequest.amount,
        depositType: "ORIGIN_CHAIN",
        recipient: OWNER_NEAR,
        refundTo: OWNER_EVM,
      },
      managerPublicKey: signed.manager_public_key,
    });
    assert.equal(v.ok, true);
    assert.equal(v.verified, true);
    assert.ok(v.quote_hash);
  });

  it("rejects unsigned, mutated, stale, and mismatched quotes", () => {
    const kp = nacl.sign.keyPair();
    const quoteRequest = {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ASSETS.eth_usdc.asset_id,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: ASSETS.arb_usdc.asset_id,
      amount: "1000000",
      refundTo: OWNER_EVM,
      refundType: "ORIGIN_CHAIN",
      recipient: OWNER_EVM,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 600_000).toISOString(),
    };
    const quote = {
      amountIn: "1000000",
      amountInFormatted: "1",
      amountInUsd: "1",
      minAmountIn: "1000000",
      amountOut: "994000",
      amountOutFormatted: "0.994",
      amountOutUsd: "0.994",
      minAmountOut: "990000",
      depositAddress: ESCROW,
      deadline: quoteRequest.deadline,
    };
    const signed = buildLocallySignedQuoteResponse({
      quoteRequest,
      quote,
      secretKey64: Buffer.from(kp.secretKey),
    });
    const mgr = signed.manager_public_key;

    assert.equal(
      verifySignedOneClickQuote(
        { ...signed, signature: null },
        { managerPublicKey: mgr }
      ).reason,
      "unsigned_quote"
    );

    // SDK >=0.1.26 non-dry: depositAddress IS in signed subset — mutation must fail.
    const mutations = [
      ["depositAddress", (c) => {
        c.quote.depositAddress = "0x0000000000000000000000000000000000000bad";
      }],
      ["recipient", (c) => {
        c.quoteRequest.recipient = "0x0000000000000000000000000000000000000bad";
      }],
      ["refundTo", (c) => {
        c.quoteRequest.refundTo = "0x0000000000000000000000000000000000000bad";
      }],
      ["amountIn", (c) => {
        c.quote.amountIn = "999999";
      }],
      ["amountOut", (c) => {
        c.quote.amountOut = "1";
      }],
      ["minAmountOut", (c) => {
        c.quote.minAmountOut = "1";
      }],
      ["deadline", (c) => {
        c.quote.deadline = new Date(Date.now() + 999_000).toISOString();
      }],
      ["originAsset", (c) => {
        c.quoteRequest.originAsset = ASSETS.arb_usdc.asset_id;
      }],
      ["destinationAsset", (c) => {
        c.quoteRequest.destinationAsset = ASSETS.wrap_near.asset_id;
      }],
    ];
    for (const [name, mut] of mutations) {
      const mutated = mutateQuoteResponse(signed, mut);
      assert.equal(
        verifySignedOneClickQuote(mutated, { managerPublicKey: mgr }).ok,
        false,
        `mutation of ${name} must invalidate non-dry signature`
      );
    }

    assert.equal(
      verifySignedOneClickQuote(signed, {
        managerPublicKey: mgr,
        nowMs: Date.now() + 20 * 60_000,
        maxAgeMs: 15 * 60_000,
      }).reason,
      "stale_quote"
    );

    assert.equal(
      verifySignedOneClickQuote(signed, {
        managerPublicKey: mgr,
        agentRequest: {
          originAsset: quoteRequest.originAsset,
          destinationAsset: quoteRequest.destinationAsset,
          amount: "999999",
          depositType: "ORIGIN_CHAIN",
          recipient: OWNER_EVM,
          refundTo: OWNER_EVM,
        },
      }).ok,
      false
    );

    assert.equal(
      verifySignedOneClickQuote(signed, {
        managerPublicKey: ONE_CLICK_MANAGER_PUB_KEY,
      }).ok,
      false,
      "wrong manager key must fail"
    );
  });

  it("refuses attestation when 1Click verify fails (fail closed)", () => {
    const attestor = nacl.sign.keyPair();
    const bad = {
      quoteRequest: {
        dry: false,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: ASSETS.eth_usdc.asset_id,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: ASSETS.arb_usdc.asset_id,
        amount: "1000000",
        refundTo: OWNER_EVM,
        refundType: "ORIGIN_CHAIN",
        recipient: OWNER_EVM,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 600_000).toISOString(),
      },
      quote: {
        amountIn: "1000000",
        amountInFormatted: "1",
        amountInUsd: "1",
        minAmountIn: "1000000",
        amountOut: "994000",
        amountOutFormatted: "0.994",
        amountOutUsd: "0.994",
        minAmountOut: "990000",
        depositAddress: ESCROW,
        deadline: new Date(Date.now() + 600_000).toISOString(),
      },
      signature: "ed25519:11111111111111111111111111111111",
      timestamp: new Date().toISOString(),
      correlationId: "bad",
    };
    const r = attestTidepoolQuote({
      quoteResponse: bad,
      agentRequest: {
        originAsset: ASSETS.eth_usdc.asset_id,
        destinationAsset: ASSETS.arb_usdc.asset_id,
        amount: "1000000",
        depositType: "ORIGIN_CHAIN",
        recipient: OWNER_EVM,
        refundTo: OWNER_EVM,
      },
      tokenContract: ASSETS.eth_usdc.token_contract,
      chainId: 1,
      maxGasPrice: "5000000000",
      gasLimit: "250000",
      secretKey64: Buffer.from(attestor.secretKey),
    });
    assert.equal(r.ok, false);
    const reasons = (r.checks || []).filter((c) => !c.ok).map((c) => c.reason).join("|");
    assert.match(reasons, /one_click_verify|signature_invalid/);
  });
});

describe("J5 quote → attestation → ERC-20 path", () => {
  it("USDC → NEAR path: verify, attest, escrow bind, digest (local)", () => {
    const r = runLocalQuoteAuthorizationPath({
      route: {
        id: "eth_usdc_to_wrap_near",
        source: ASSETS.eth_usdc,
        destination: ASSETS.wrap_near,
      },
      amountIn: "1000000",
      amountOut: "300000000000000000000000",
      minAmountOut: "297000000000000000000000",
      depositAddress: ESCROW,
      recipient: OWNER_NEAR,
      refundTo: OWNER_EVM,
      mandateEpoch: MAINNET_EPOCH,
    });
    assert.equal(r.ok, true, JSON.stringify(r.policy || r));
    assert.equal(r.deposit_is_escrow, true);
    assert.equal(r.attestation_sig_ok, true);
    assert.equal(r.tx.to, ESCROW);
    assert.ok(r.tx.data_hex.startsWith("0xa9059cbb"));
    assert.ok(r.tx.digest_hex.length === 64);
    assert.equal(r.broadcast, false);
    // Cross-decimal: policy may accept but risk flags unsafe
    assert.equal(
      r.decimalsRisk.can_safely_validate_value_slippage_exposure,
      false
    );
  });

  it("USDC → USDC path: same-decimal policy safe", () => {
    const r = runLocalQuoteAuthorizationPath({
      route: {
        id: "eth_usdc_to_arb_usdc",
        source: ASSETS.eth_usdc,
        destination: ASSETS.arb_usdc,
      },
      amountIn: "1000000",
      amountOut: "997000",
      minAmountOut: "995000", // >= floor at 50 bps
      depositAddress: "0x2222222222222222222222222222222222222222",
      recipient: OWNER_EVM,
      refundTo: OWNER_EVM,
      mandateEpoch: MAINNET_EPOCH,
    });
    assert.equal(r.ok, true, JSON.stringify(r.policy || r));
    assert.equal(r.decimalsRisk.can_safely_validate_value_slippage_exposure, true);
    assert.equal(r.decimalsRisk.same_decimal_scale, true);
  });

  it("rejects manipulated deposit / amount / chain / destination", () => {
    const base = runLocalQuoteAuthorizationPath({
      route: {
        id: "eth_usdc_to_arb_usdc",
        source: ASSETS.eth_usdc,
        destination: ASSETS.arb_usdc,
      },
      amountIn: "1000000",
      amountOut: "997000",
      minAmountOut: "995000",
      depositAddress: ESCROW,
      recipient: OWNER_EVM,
      refundTo: OWNER_EVM,
    });
    assert.equal(base.ok, true, JSON.stringify(base.policy || base));

    const evilTx = buildErc20TxParams({
      depositAddress: "0x0000000000000000000000000000000000000bad",
      tokenContract: base.attestation.token_contract,
      amountIn: base.attestation.amount_in,
      chainId: base.attestation.chain_id,
      gasPrice: base.attestation.max_gas_price,
      gasLimit: base.attestation.gas_limit,
    });
    const badDeposit = simulatePolicyChecks({
      attestation: base.attestation,
      tx: evilTx,
      allowedAssets: new Set([ASSETS.eth_usdc.asset_id, ASSETS.arb_usdc.asset_id]),
      allowedDestinations: new Set([OWNER_EVM.toLowerCase()]),
      allowedChains: new Set([1]),
      maxTradeValue: "100000000",
      maxGasBudget: "5000000000000000",
      trustedSigners: new Set(["ed25519:placeholder"]),
      signerPublicKey: "ed25519:placeholder",
      nowNs: BigInt(Date.now()) * 1_000_000n,
    });
    assert.ok(badDeposit.fails.includes("tx_to_ne_deposit"));

    const badAmt = simulatePolicyChecks({
      attestation: base.attestation,
      tx: { ...base.tx, amount: "999999" },
      allowedAssets: new Set([ASSETS.eth_usdc.asset_id, ASSETS.arb_usdc.asset_id]),
      allowedDestinations: new Set([OWNER_EVM.toLowerCase()]),
      allowedChains: new Set([1]),
      maxTradeValue: "100000000",
      maxGasBudget: "5000000000000000",
      trustedSigners: new Set(["ed25519:x"]),
      signerPublicKey: "ed25519:x",
      nowNs: BigInt(Date.now()) * 1_000_000n,
    });
    assert.ok(badAmt.fails.includes("tx_amount_mismatch"));

    const badChain = simulatePolicyChecks({
      attestation: { ...base.attestation, chain_id: "8453" },
      tx: { ...base.tx, chain_id: 8453 },
      allowedAssets: new Set([ASSETS.eth_usdc.asset_id, ASSETS.arb_usdc.asset_id]),
      allowedDestinations: new Set([OWNER_EVM.toLowerCase()]),
      allowedChains: new Set([1]),
      maxTradeValue: "100000000",
      maxGasBudget: "5000000000000000",
      trustedSigners: new Set(["ed25519:x"]),
      signerPublicKey: "ed25519:x",
      nowNs: BigInt(Date.now()) * 1_000_000n,
    });
    assert.ok(badChain.fails.includes("chain_id_not_allowed"));

    // Replay: same attestation id twice
    const once = simulatePolicyChecks({
      attestation: base.attestation,
      tx: base.tx,
      allowedAssets: new Set([ASSETS.eth_usdc.asset_id, ASSETS.arb_usdc.asset_id]),
      allowedDestinations: new Set([OWNER_EVM.toLowerCase()]),
      allowedChains: new Set([1]),
      maxTradeValue: "100000000",
      maxGasBudget: "5000000000000000",
      trustedSigners: new Set(["ed25519:x"]),
      signerPublicKey: "ed25519:x",
      usedAttestationIds: new Set([base.attestation_id]),
      nowNs: BigInt(Date.now()) * 1_000_000n,
    });
    assert.ok(once.fails.includes("attestation_already_used"));
  });
});

describe("J5 decimals risk + AI quote-level inputs", () => {
  it("reports cross-decimal unsafe routes fail-closed", () => {
    const report = buildDecimalsRiskReport();
    assert.ok(report.unsafe_route_ids.includes("eth_usdc_to_wrap_near"));
    assert.ok(report.unsafe_route_ids.includes("eth_weth_to_eth_usdc"));
    assert.ok(
      report.safe_for_tiny_funded_usdc_stable_bridge.includes("eth_usdc_to_arb_usdc")
    );
    const nearOrigin = analyzeDecimalsRisk({
      amountIn: "1000000000000000000000000",
      minAmountOut: "3000000",
      decimalsIn: 24,
      decimalsOut: 6,
      assetIn: "wNEAR",
      assetOut: "USDC",
      maxTradeValue: "1000000",
    });
    assert.equal(nearOrigin.can_safely_validate_value_slippage_exposure, false);
  });

  it("live_1click market fragment exposes quote-level economics", () => {
    const matrix = {
      ok: true,
      quoted_count: 1,
      eligible_count: 0,
      proposal: { choice: "NO_TRADE" },
      matrix: [
        {
          ok: true,
          status: "QUOTED",
          id: "eth_usdc_to_wrap_near",
          route: {
            id: "eth_usdc_to_wrap_near",
            label: "Ethereum USDC → NEAR wNEAR",
            source_chain: "ethereum",
            destination_chain: "near",
          },
          source: {
            chain: "ethereum",
            asset_id: ASSETS.eth_usdc.asset_id,
            symbol: "USDC",
            decimals: 6,
            contract_address: ASSETS.eth_usdc.token_contract,
          },
          destination: {
            chain: "near",
            asset_id: ASSETS.wrap_near.asset_id,
            symbol: "wNEAR",
            decimals: 24,
            contract_address: "wrap.near",
          },
          amount_out: "297493126134261336515512",
          amount_out_usd: 0.99,
          quote: {
            ok: true,
            dry: true,
            quoted_at: new Date().toISOString(),
            correlation_id: "abc",
            quote: {
              amountIn: "1000000",
              amountOut: "297493126134261336515512",
              minAmountOut: "294518194872918723150356",
              amountInUsd: "1",
              amountOutUsd: "0.99",
              refundFee: "0",
              withdrawFee: "0",
            },
            request: {
              originAsset: ASSETS.eth_usdc.asset_id,
              destinationAsset: ASSETS.wrap_near.asset_id,
              amount: "1000000",
            },
          },
          capital: { ok: false, reason: "no_balance_entry" },
          signing: { primitive: "EVM_ERC20_TRANSFER_TO_DEPOSIT" },
        },
      ],
    };
    const frag = buildLiveQuoteMarketFragment(matrix);
    assert.equal(frag.quotes.length, 1);
    const econ = extractQuoteEconomics(matrix.matrix[0]);
    assert.equal(econ.amount_in_raw, "1000000");
    assert.ok(econ.min_amount_out_raw);
    assert.equal(econ.asset_in_id, ASSETS.eth_usdc.asset_id);
    const proof = assertQuoteLevelConsumed(
      { live_1click: frag },
      { strategist_choice: "NO_TRADE", may_sign: false }
    );
    assert.equal(proof.ok, true);
    assert.equal(proof.no_trade_preserved, true);
  });
});

describe("J5.1 live dry quote verification (authentic body)", () => {
  it("preserves signature/timestamp and verifies with pinned manager key", async () => {
    const q = await productionDryQuote({
      originAsset: ASSETS.eth_usdc.asset_id,
      destinationAsset: ASSETS.arb_usdc.asset_id,
      amount: "1000000",
      refundTo: OWNER_EVM,
      recipient: OWNER_EVM,
    });
    if (!q.ok) {
      assert.ok(
        [
          "quote_tls_error",
          "quote_network_error",
          "jwt_required",
          "quote_http_error",
          "malformed_one_click_response",
        ].includes(q.reason),
        `unexpected fail ${q.reason}`
      );
      return;
    }
    assert.equal(q.dry, true);
    assert.ok(q.one_click_response?.signature, "signature must be preserved");
    assert.ok(q.one_click_response?.timestamp, "timestamp must be preserved");
    assert.ok(q.one_click_response?.quoteRequest);
    assert.equal(q.one_click_verify.manager_key_mode, "pinned_official");
    assert.equal(
      q.one_click_verify.ok,
      true,
      `live dry verify failed: ${q.one_click_verify.reason}`
    );
    // Live minOut vs deployed 100 bps floor — never inflate values
    const minOut = q.min_amount_out || q.quote.minAmountOut;
    const policy = evaluateLiveMinOutAgainstPolicy({
      amountIn: q.amount_in || "1000000",
      minAmountOut: minOut,
      maxSlippageBps: 100,
      label: "live_dry",
    });
    assert.equal(policy.altered_values, false);
    assert.equal(policy.policy_floor, "990000");
    if (BigInt(minOut) < 990000n) {
      assert.equal(policy.result, "BLOCKED");
    }
  });
});
