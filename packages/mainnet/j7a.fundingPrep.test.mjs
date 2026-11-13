import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ARBITRUM_NATIVE_USDC,
  ARBITRUM_USDC_E,
  ATTESTOR_GAS_LIMIT,
  ATTESTOR_MAX_GAS_PRICE_WEI,
  evaluateAttestorGasFit,
  recommendEthFunding,
  recommendUsdcFunding,
  buildErc20TransferData,
} from "./arbitrumFunding.mjs";

describe("J7A funding prep helpers", () => {
  it("fails closed when live gas price exceeds attestor max", () => {
    const fit = evaluateAttestorGasFit({
      liveGasPriceWei: ATTESTOR_MAX_GAS_PRICE_WEI + 1n,
      estimatedGas: 65_000,
    });
    assert.equal(fit.ok, false);
    assert.equal(fit.incompatibilities[0].code, "live_gas_price_exceeds_attestor_max_gas_price");
  });

  it("fails closed when estimated gas exceeds attestor limit", () => {
    const fit = evaluateAttestorGasFit({
      liveGasPriceWei: 20_000_000n,
      estimatedGas: ATTESTOR_GAS_LIMIT + 1n,
    });
    assert.equal(fit.ok, false);
    assert.equal(fit.incompatibilities[0].code, "estimated_gas_exceeds_attestor_gas_limit");
  });

  it("passes under current-like Arbitrum conditions", () => {
    const fit = evaluateAttestorGasFit({
      liveGasPriceWei: 20_002_000n,
      estimatedGas: 63_261,
    });
    assert.equal(fit.ok, true);
    assert.equal(fit.incompatibilities.length, 0);
  });

  it("recommends ETH from measured fees, not a fixed guess", () => {
    const fit = evaluateAttestorGasFit({
      liveGasPriceWei: 20_002_000n,
      estimatedGas: 63_261,
    });
    const rec = recommendEthFunding({
      liveCaseFeeWei: fit.live_case_fee_wei,
      attestorCeilingFeeWei: fit.attestor_ceiling_fee_wei,
    });
    assert.ok(BigInt(rec.recommended_wei) > 0n);
    assert.ok(BigInt(rec.recommended_wei) >= BigInt(fit.attestor_ceiling_fee_wei));
    assert.ok(rec.recommended_eth < 0.001);
  });

  it("recommends small native USDC only (not USDC.e)", () => {
    const u = recommendUsdcFunding();
    assert.equal(u.recommended_units, "2000000");
    assert.equal(u.token, ARBITRUM_NATIVE_USDC);
    assert.notEqual(u.token, ARBITRUM_USDC_E);
  });

  it("builds ERC-20 transfer calldata", () => {
    const data = buildErc20TransferData(
      "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4",
      "1000000"
    );
    assert.ok(data.startsWith("0xa9059cbb"));
    assert.equal(data.length, 2 + 8 + 64 + 64);
  });
});
