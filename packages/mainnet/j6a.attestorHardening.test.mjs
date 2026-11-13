/**
 * J6A — attestor production hardening (no secrets, no mainnet mutations).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import {
  attestTidepoolQuote,
  attestationMessageV2,
  signAttestation,
  publicKeyEd25519,
} from "../intents-codec/quote-auth.mjs";
import bs58 from "bs58";
import {
  buildLocallySignedQuoteResponse,
} from "../intents-codec/oneClickVerify.mjs";
import { ASSETS, MPC_EVM } from "./quotePath.mjs";

const ESCROW = "0x1111111111111111111111111111111111111111";

function makeFundedSigned() {
  const mgr = nacl.sign.keyPair();
  const quoteRequest = {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 25,
    originAsset: ASSETS.arb_usdc.asset_id,
    depositType: "ORIGIN_CHAIN",
    destinationAsset:
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    amount: "1000000",
    refundTo: MPC_EVM,
    refundType: "ORIGIN_CHAIN",
    recipient: MPC_EVM,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 600_000).toISOString(),
  };
  const quote = {
    amountIn: "1000000",
    amountInFormatted: "1",
    amountInUsd: "1",
    minAmountIn: "1000000",
    amountOut: "997398",
    amountOutFormatted: "0.997",
    amountOutUsd: "0.997",
    minAmountOut: "994904",
    depositAddress: ESCROW,
    deadline: new Date(Date.now() + 3 * 24 * 3600_000).toISOString(),
    timeWhenInactive: new Date(Date.now() + 3 * 24 * 3600_000).toISOString(),
    timeEstimate: 30,
    refundFee: "5300",
    withdrawFee: "2400",
  };
  const signed = buildLocallySignedQuoteResponse({
    quoteRequest,
    quote,
    secretKey64: Buffer.from(mgr.secretKey),
  });
  return { signed, mgr, quoteRequest, quote };
}

describe("J6A attestor hardening", () => {
  let prevNet;
  before(() => {
    prevNet = process.env.NIO_NETWORK;
    process.env.NIO_NETWORK = "mainnet";
    process.env.NEAR_NETWORK = "mainnet";
  });
  after(() => {
    if (prevNet === undefined) delete process.env.NIO_NETWORK;
    else process.env.NIO_NETWORK = prevNet;
    delete process.env.NIO_ALLOW_TEST_FIXTURE;
  });

  it("ignores untrusted quoteResponse._fixture and enforces production", () => {
    const attestor = nacl.sign.keyPair();
    const { signed, quoteRequest } = makeFundedSigned();
    // Attacker sets _fixture on the response — must NOT bypass production
    signed._fixture = true;
    const r = attestTidepoolQuote({
      quoteResponse: signed,
      agentRequest: {
        originAsset: quoteRequest.originAsset,
        destinationAsset: quoteRequest.destinationAsset,
        amount: quoteRequest.amount,
        depositType: "ORIGIN_CHAIN",
        recipient: MPC_EVM,
        refundTo: MPC_EVM,
      },
      tokenContract: ASSETS.arb_usdc.token_contract,
      chainId: 42161,
      maxGasPrice: "100000000",
      gasLimit: "250000",
      secretKey64: Buffer.from(attestor.secretKey),
      tidepoolManagerPubKey: signed.manager_public_key,
      // production via env+fundedShape; no allowTestFixtureMode
    });
    // With env mainnet + funded + no trusted fixture mode → production →
    // alternate manager key forbidden OR signature fails against pinned key
    assert.equal(r.ok, false);
    const reasons = (r.checks || [])
      .filter((c) => !c.ok)
      .map((c) => c.reason)
      .join("|");
    assert.match(
      reasons + (r.checks?.find((c) => c.reason)?.reason || ""),
      /alternate_manager_key|one_click_verify|production/
    );
  });

  it("rejects allowUnverifiedOneClick on productionMode", () => {
    const attestor = nacl.sign.keyPair();
    const { signed, quoteRequest } = makeFundedSigned();
    const r = attestTidepoolQuote({
      quoteResponse: signed,
      agentRequest: {
        originAsset: quoteRequest.originAsset,
        destinationAsset: quoteRequest.destinationAsset,
        amount: quoteRequest.amount,
        depositType: "ORIGIN_CHAIN",
        recipient: MPC_EVM,
        refundTo: MPC_EVM,
      },
      tokenContract: ASSETS.arb_usdc.token_contract,
      chainId: 42161,
      maxGasPrice: "100000000",
      gasLimit: "250000",
      secretKey64: Buffer.from(attestor.secretKey),
      productionMode: true,
      allowUnverifiedOneClick: true,
      tidepoolManagerPubKey: signed.manager_public_key,
    });
    assert.equal(r.ok, false);
  });

  it("rejects expired quote deadline", () => {
    const attestor = nacl.sign.keyPair();
    const { signed, quoteRequest } = makeFundedSigned();
    signed.quote.deadline = new Date(Date.now() - 60_000).toISOString();
    // Re-sign after mutation so oneClick can pass under fixture mode
    const mgr = nacl.sign.keyPair();
    const resigned = buildLocallySignedQuoteResponse({
      quoteRequest,
      quote: signed.quote,
      secretKey64: Buffer.from(mgr.secretKey),
    });
    const r = attestTidepoolQuote({
      quoteResponse: resigned,
      agentRequest: {
        originAsset: quoteRequest.originAsset,
        destinationAsset: quoteRequest.destinationAsset,
        amount: quoteRequest.amount,
        depositType: "ORIGIN_CHAIN",
        recipient: MPC_EVM,
        refundTo: MPC_EVM,
      },
      tokenContract: ASSETS.arb_usdc.token_contract,
      chainId: 42161,
      maxGasPrice: "100000000",
      gasLimit: "250000",
      secretKey64: Buffer.from(attestor.secretKey),
      tidepoolManagerPubKey: resigned.manager_public_key,
      allowTestFixtureMode: true,
    });
    assert.equal(r.ok, false);
    assert.match(
      (r.checks || []).map((c) => c.reason).join("|"),
      /quote_deadline_expired/
    );
  });

  it("QUOTE_AUTH_V2 message format matches Rust prefix", () => {
    const msg = attestationMessageV2({
      depositAddress: ESCROW,
      amountIn: "1000000",
      assetIn: ASSETS.arb_usdc.asset_id,
      assetOut:
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      minAmountOut: "994904",
      quoteDeadlineNs: "123",
      tokenContract: ASSETS.arb_usdc.token_contract,
      chainId: "42161",
      recipient: MPC_EVM,
      refundTo: MPC_EVM,
      correlationId: "corr",
      quoteHash: "hash",
      maxGasPrice: "100000000",
      gasLimit: "250000",
    }).toString("utf8");
    assert.ok(msg.startsWith("QUOTE_AUTH_V2\n"));
    assert.ok(msg.includes(`deposit=${ESCROW.toLowerCase()}`));
    assert.ok(msg.includes("chain_id=42161"));
    assert.ok(msg.includes("min_out=994904"));
  });

  it("trusted allowTestFixtureMode can attest locally signed non-dry", () => {
    const attestor = nacl.sign.keyPair();
    const { signed, quoteRequest } = makeFundedSigned();
    const r = attestTidepoolQuote({
      quoteResponse: signed,
      agentRequest: {
        originAsset: quoteRequest.originAsset,
        destinationAsset: quoteRequest.destinationAsset,
        amount: quoteRequest.amount,
        depositType: "ORIGIN_CHAIN",
        recipient: MPC_EVM,
        refundTo: MPC_EVM,
      },
      tokenContract: ASSETS.arb_usdc.token_contract,
      chainId: 42161,
      maxGasPrice: "100000000",
      gasLimit: "250000",
      secretKey64: Buffer.from(attestor.secretKey),
      tidepoolManagerPubKey: signed.manager_public_key,
      allowTestFixtureMode: true,
      policyLimits: {
        max_trade_value: "5000000",
        max_slippage_bps: 100,
        max_gas_budget: "2500000000000000",
      },
      allowedDestinations: [MPC_EVM],
      allowedAssets: [
        ASSETS.arb_usdc.asset_id,
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      ],
      allowedChains: ["eip155:42161", "42161"],
    });
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    const msg = Buffer.from(r.message_utf8, "utf8");
    const sigBody = r.signature.replace(/^ed25519:/, "");
    assert.ok(
      nacl.sign.detached.verify(
        msg,
        bs58.decode(sigBody),
        attestor.publicKey
      )
    );
  });
});
