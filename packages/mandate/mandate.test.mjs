import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_SCOPE,
  assetId,
  validateMandate,
  assetAllowedByMandate,
  parseAssetId,
} from "./schema.mjs";
import {
  createDiscoveryHub,
  createStaticRegistrySource,
  verifiedMainnetSeedTokens,
  advanceStage,
  shortlistForLlm,
} from "../discovery/index.mjs";
import {
  createExecutionRouter,
  createEvmAggregatorStub,
  createNearNativeDexStub,
  validateEvmAggregatorTx,
  ROUTE_STATUS,
} from "../execution/router.mjs";

describe("mandate schema", () => {
  it("defaults to allowlist and rejects implicit ANY", () => {
    const bad = validateMandate({
      token_scope: TOKEN_SCOPE.ANY_ELIGIBLE_TOKEN,
      allowed_chains: ["near"],
      // missing explicit_any_token_authorization
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.reasons.includes("any_token_requires_explicit_owner_authorization"));
  });

  it("allowlist requires canonical asset ids", () => {
    const bad = validateMandate({
      token_scope: TOKEN_SCOPE.ALLOWLIST,
      allowed_chains: ["eip155:1"],
      allowed_assets: ["USDC"],
    });
    assert.equal(bad.ok, false);
  });

  it("builds and matches canonical ERC-20 / NEP-141 ids", () => {
    const usdcArb = assetId({
      chain: "eip155:42161",
      kind: "erc20",
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    });
    assert.equal(
      usdcArb,
      "eip155:42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831"
    );
    const ok = validateMandate({
      token_scope: TOKEN_SCOPE.ALLOWLIST,
      allowed_chains: ["eip155:42161", "near"],
      allowed_assets: [usdcArb, "nep141:wrap.near"],
      max_trade_value: "1000000",
    });
    assert.equal(ok.ok, true);
    assert.equal(assetAllowedByMandate(ok.mandate, usdcArb), true);
    assert.equal(
      assetAllowedByMandate(ok.mandate, "eip155:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
      false
    );
  });

  it("ANY mode permits by chain membership", () => {
    const ok = validateMandate({
      token_scope: TOKEN_SCOPE.ANY_ELIGIBLE_TOKEN,
      explicit_any_token_authorization: true,
      allowed_chains: ["eip155:8453"],
      allowed_assets: [],
    });
    assert.equal(ok.ok, true);
    assert.equal(
      assetAllowedByMandate(
        ok.mandate,
        "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
      ),
      true
    );
    assert.equal(assetAllowedByMandate(ok.mandate, "native:near"), false);
  });
});

describe("discovery + execution", () => {
  it("stages candidates and shortlists without dumping universe", async () => {
    const hub = createDiscoveryHub([
      createStaticRegistrySource(verifiedMainnetSeedTokens()),
    ]);
    const found = await hub.discover({ chains: ["eip155:42161", "near"], limit: 20 });
    assert.ok(found.length >= 2);
    let c = advanceStage(found[0], "RISK_CHECKED", { ok: true });
    c = advanceStage(c, "QUOTEABLE", { ok: true });
    const short = shortlistForLlm([c], { max: 5 });
    assert.equal(short.length, 1);
    assert.ok(!short[0].asset_id.includes("undefined"));
  });

  it("router returns UNSUPPORTED for unwired EVM/NEAR DEX adapters", async () => {
    const router = createExecutionRouter([
      createEvmAggregatorStub(),
      createNearNativeDexStub(),
    ]);
    const best = await router.quoteBest({
      asset_in: "eip155:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      asset_out: "native:eip155:1",
      amount: "1000000",
    });
    assert.equal(best.ok, false);
    assert.equal(best.status, ROUTE_STATUS.NO_SAFE_LIQUIDITY);
  });

  it("refuses undecoded aggregator calldata", () => {
    const v = validateEvmAggregatorTx({
      chainId: 1,
      to: "0xdef",
      data: "0xabcd",
      spender: "0xspender",
      unlimitedApproval: true,
    });
    assert.equal(v.ok, false);
    assert.ok(v.reasons.includes("unlimited_approval_forbidden"));
    assert.ok(v.reasons.includes("undecoded_calldata_cannot_sign"));
  });

  it("parseAssetId never treats symbols as identities", () => {
    assert.equal(parseAssetId("USDC").kind, "legacy_or_unknown");
  });
});
