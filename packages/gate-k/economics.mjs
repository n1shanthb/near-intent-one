/**
 * Economic viability with conservative safety buffer.
 * Preserves Gate J behavior: edge must exceed fees + impact + buffer.
 */
import { DEFAULT_EDGE_BUFFER_BPS } from "./constants.mjs";

/**
 * @param {object} args
 * @param {bigint|string|number} args.edge_bps — expected edge in bps
 * @param {bigint|string|number} [args.fee_bps]
 * @param {bigint|string|number} [args.price_impact_bps]
 * @param {number} [args.buffer_bps]
 * @param {bigint|string} [args.amount_in]
 * @param {bigint|string} [args.amount_out]
 * @param {bigint|string} [args.min_out]
 */
export function assessEconomicViability({
  edge_bps,
  fee_bps = 0,
  price_impact_bps = 0,
  buffer_bps = DEFAULT_EDGE_BUFFER_BPS,
  amount_in,
  amount_out,
  min_out,
}) {
  const edge = Number(edge_bps || 0);
  const fees = Number(fee_bps || 0);
  const impact = Number(price_impact_bps || 0);
  const buffer = Number(buffer_bps || 0);
  const required = fees + impact + buffer;
  const viable = edge > required;

  const ain = BigInt(amount_in || "0");
  const size_ok = ain > 0n;
  // amount_out optional until a fresh quote is bound; skip liquidity when omitted
  let liquidity_ok = true;
  if (amount_out != null && amount_out !== "") {
    const aout = BigInt(amount_out || "0");
    const mout = BigInt(min_out || "0");
    liquidity_ok = aout > 0n && (mout === 0n || aout >= mout);
  }

  return {
    ok: viable && liquidity_ok && size_ok,
    edge_bps: edge,
    fee_bps: fees,
    price_impact_bps: impact,
    buffer_bps: buffer,
    required_bps: required,
    surplus_bps: edge - required,
    liquidity_ok,
    size_ok,
    reason: !size_ok
      ? "ZERO_SIZE"
      : !liquidity_ok
        ? "LIQUIDITY"
        : !viable
          ? "ECONOMIC_NOT_VIABLE"
          : "OK",
  };
}
