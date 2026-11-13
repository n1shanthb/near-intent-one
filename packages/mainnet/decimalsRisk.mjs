/**
 * Cross-token decimals / raw-amount policy risk analysis (fail-closed reporting).
 * Deployed contract uses raw amount_in — NOT universal USD units.
 */

export const DECIMALS_PROFILE = Object.freeze({
  USDC: 6,
  WETH: 18,
  "wNEAR": 24,
  NEAR: 24,
});

/**
 * Policy slippage check mirrors contracts/policy propose_quoted_evm_transfer:
 * floor = amount_in * (10000 - max_slippage_bps) / 10000
 * accept if min_amount_out >= floor OR min_amount_out >= amount_in
 *
 * This is only meaningful when amount_in and min_amount_out share the same
 * decimal scale (e.g. USDC→USDC). Cross-decimal routes are unsafe/loose.
 */
export function analyzeDecimalsRisk({
  amountIn,
  minAmountOut,
  decimalsIn,
  decimalsOut,
  assetIn,
  assetOut,
  maxSlippageBps = 50,
  maxTradeValue = null,
}) {
  const din = Number(decimalsIn);
  const dout = Number(decimalsOut);
  const sameScale = din === dout;
  const ain = BigInt(amountIn);
  const mout = BigInt(minAmountOut);
  const minRatio = 10_000n - BigInt(maxSlippageBps);
  const floor = (ain * minRatio) / 10_000n;
  const policyAccepts = mout >= floor || mout >= ain;

  let classification = "SAFE_SAME_DECIMALS";
  let canSafelyValidate = true;
  const risks = [];

  if (!Number.isFinite(din) || !Number.isFinite(dout)) {
    classification = "UNKNOWN_DECIMALS";
    canSafelyValidate = false;
    risks.push("missing_decimals");
  } else if (!sameScale) {
    if (dout > din && policyAccepts) {
      classification = "UNSAFE_LOOSE_SLIPPAGE";
      canSafelyValidate = false;
      risks.push(
        "min_amount_out raw >> amount_in raw solely due to higher out decimals — policy slippage floor does not measure economic slip"
      );
    } else if (dout < din && !policyAccepts) {
      classification = "FALSE_REJECT_CROSS_DECIMALS";
      canSafelyValidate = false;
      risks.push(
        "min_amount_out raw << amount_in raw due to lower out decimals — policy would reject economically valid quotes"
      );
    } else {
      classification = "CROSS_DECIMALS_UNSAFE";
      canSafelyValidate = false;
      risks.push("amount_in vs min_amount_out not comparable without normalization");
    }
  }

  if (maxTradeValue != null) {
    const cap = BigInt(maxTradeValue);
    if (ain > cap) {
      risks.push("amount_in_exceeds_max_trade_value_raw");
    }
    // Mixing 6-dec USDC and 18-dec WETH under one raw max_trade_value is incoherent.
    if (din !== 6 && din !== dout) {
      risks.push(
        "max_trade_value is raw amount_in units — not USD; cannot compare exposure across token decimals"
      );
      canSafelyValidate = false;
      if (classification === "SAFE_SAME_DECIMALS") {
        classification = "EXPOSURE_UNIT_MISMATCH";
      }
    }
  }

  return {
    asset_in: assetIn,
    asset_out: assetOut,
    decimals_in: din,
    decimals_out: dout,
    same_decimal_scale: sameScale,
    amount_in: String(amountIn),
    min_amount_out: String(minAmountOut),
    policy_floor: String(floor),
    policy_would_accept: policyAccepts,
    classification,
    can_safely_validate_value_slippage_exposure: canSafelyValidate,
    risks,
    recommendation: canSafelyValidate
      ? "route_ok_for_raw_policy_checks"
      : "fail_closed — do not fund this route until policy uses USD/normalized units or per-asset caps",
  };
}

/**
 * Static matrix for common four-chain routes.
 */
export function buildDecimalsRiskReport() {
  const cases = [
    {
      id: "eth_usdc_to_wrap_near",
      amountIn: "1000000",
      minAmountOut: "294518194872918723150356",
      decimalsIn: 6,
      decimalsOut: 24,
      assetIn: "USDC(6)",
      assetOut: "wNEAR(24)",
    },
    {
      id: "eth_usdc_to_arb_usdc",
      amountIn: "1000000",
      minAmountOut: "994498",
      decimalsIn: 6,
      decimalsOut: 6,
      assetIn: "USDC(6)",
      assetOut: "USDC(6)",
    },
    {
      id: "eth_weth_to_eth_usdc",
      amountIn: "1000000000000000", // 0.001 WETH
      minAmountOut: "2500000", // ~2.5 USDC
      decimalsIn: 18,
      decimalsOut: 6,
      assetIn: "WETH(18)",
      assetOut: "USDC(6)",
    },
    {
      id: "wrap_near_to_eth_usdc",
      amountIn: "1000000000000000000000000", // 1 wNEAR
      minAmountOut: "3000000",
      decimalsIn: 24,
      decimalsOut: 6,
      assetIn: "wNEAR(24)",
      assetOut: "USDC(6)",
    },
    {
      id: "eth_usdc_to_eth_weth",
      amountIn: "1000000",
      minAmountOut: "300000000000000",
      decimalsIn: 6,
      decimalsOut: 18,
      assetIn: "USDC(6)",
      assetOut: "WETH(18)",
    },
  ];

  const rows = cases.map((c) => ({
    id: c.id,
    ...analyzeDecimalsRisk({ ...c, maxSlippageBps: 50, maxTradeValue: "1000000" }),
  }));

  const unsafe = rows.filter((r) => !r.can_safely_validate_value_slippage_exposure);
  return {
    contract_model: "raw_amount_in",
    note: "Fail closed — do not broaden token_scope; do not bypass slippage require!",
    one_click_signature_coverage:
      "SDK >=0.1.26: dry signs amounts only; non-dry also signs depositAddress/depositMemo/deadline/fees. 0.1.24 omitted escrow from hash (docs/SDK mismatch). Attestor sig alone ≠ escrow authenticity unless escrow_in_signed_hash.",
    rows,
    unsafe_route_ids: unsafe.map((r) => r.id),
    safe_for_tiny_funded_usdc_stable_bridge: rows
      .filter((r) => r.same_decimal_scale && r.decimals_in === 6)
      .map((r) => r.id),
  };
}
