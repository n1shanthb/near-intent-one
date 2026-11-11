/**
 * Tidepool community testnet adapter — 1Click-compatible, NOT production 1Click.
 * Supports Ethereum / Arbitrum / Base Sepolia + NEAR testnet token IDs from live catalog.
 */
import { ROUTE_STATUS } from "../execution/router.mjs";

export const TIDEPOOL_BASE =
  process.env.TIDEPOOL_URL || "https://www.usetidepool.tech";

export const TIDEPOOL_TRUST = Object.freeze({
  kind: "community_testnet_1click_compatible",
  not_official_production_1click: true,
  maker_relayer_trust:
    "Tidepool sandbox operators / makers — not NEAR Intents mainnet settlement",
  docs: "https://www.usetidepool.tech/docs",
});

/** Explicit testnet chain bindings — never reuse mainnet IDs. */
export const TIDEPOOL_EVM = Object.freeze({
  eth: Object.freeze({
    provider: "eth",
    nio_chain: "ethereum_sepolia",
    chain_id: 11155111,
    usdc: "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2",
    origin_asset:
      "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet",
  }),
  arb: Object.freeze({
    provider: "arb",
    nio_chain: "arbitrum_sepolia",
    chain_id: 421614,
    usdc: "0x38d81431B9f76d9699AF7517040D5221D9dEA252",
    origin_asset:
      "nep141:arb-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet",
  }),
  base: Object.freeze({
    provider: "base",
    nio_chain: "base_sepolia",
    chain_id: 84532,
    usdc: "0x38d81431B9f76d9699AF7517040D5221D9dEA252",
    origin_asset:
      "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet",
  }),
});

export const TIDEPOOL_WNEAR =
  "nep141:wnear.tidepool-sandbox.testnet";

export async function fetchTidepoolTokens(baseUrl = TIDEPOOL_BASE) {
  const res = await fetch(`${baseUrl}/v0/tokens`);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    return { ok: false, http_status: res.status, body, api: baseUrl };
  }
  const list = Array.isArray(body) ? body : body.tokens || [];
  return { ok: true, count: list.length, tokens: list, api: baseUrl, trust: TIDEPOOL_TRUST };
}

export async function tidepoolQuote(request, opts = {}) {
  const baseUrl = opts.baseUrl || TIDEPOOL_BASE;
  const dry = opts.dry === false ? false : true;
  if (dry === false && opts.allowFunded !== true) {
    return { ok: false, reason: "funded_tidepool_quote_requires_allowFunded" };
  }
  const body = {
    dry,
    swapType: request.swapType || "EXACT_INPUT",
    slippageTolerance: request.slippageTolerance ?? 100,
    originAsset: request.originAsset,
    depositType: request.depositType || "ORIGIN_CHAIN",
    destinationAsset: request.destinationAsset,
    amount: String(request.amount),
    refundTo: request.refundTo,
    refundType: request.refundType || "ORIGIN_CHAIN",
    recipient: request.recipient,
    recipientType: request.recipientType || "DESTINATION_CHAIN",
    deadline:
      request.deadline || new Date(Date.now() + 15 * 60_000).toISOString(),
  };
  for (const k of ["originAsset", "destinationAsset", "amount", "refundTo", "recipient"]) {
    if (!body[k]) return { ok: false, reason: `missing_${k}` };
  }
  const res = await fetch(`${baseUrl}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 800) };
  }
  if (!res.ok) {
    return {
      ok: false,
      http_status: res.status,
      reason: parsed?.message || "quote_http_error",
      body: parsed,
      request: body,
    };
  }
  const quote = parsed.quote || parsed;
  return {
    ok: true,
    dry: body.dry,
    api: baseUrl,
    trust: TIDEPOOL_TRUST,
    request: body,
    quote,
    correlation_id: parsed.correlationId || quote.correlationId || null,
    signature: parsed.signature || null,
    deposit_address: body.dry ? null : quote.depositAddress || null,
    amount_out: quote.amountOut || quote.minAmountOut || null,
    amount_out_usd_display_only: quote.amountOutUsd || null,
    min_amount_out: quote.minAmountOut || null,
    deadline: quote.deadline || body.deadline,
    status: body.dry ? ROUTE_STATUS.QUOTED : ROUTE_STATUS.QUOTED,
    note: body.dry
      ? "Dry Tidepool quote"
      : "Funded Tidepool quote — deposit address allocated; broadcast still gated",
  };
}

export async function tidepoolSubmitDeposit(txHash, opts = {}) {
  const baseUrl = opts.baseUrl || TIDEPOOL_BASE;
  const res = await fetch(`${baseUrl}/v0/deposit/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txHash }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, http_status: res.status, body };
}

export async function tidepoolStatus(depositAddress, opts = {}) {
  const baseUrl = opts.baseUrl || TIDEPOOL_BASE;
  const url = new URL(`${baseUrl}/v0/status`);
  url.searchParams.set("depositAddress", depositAddress);
  const res = await fetch(url);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, http_status: res.status, body };
}

/**
 * Quote matrix for funded-source candidates (uses precise amounts; USD fields display-only).
 */
export async function runTidepoolQuoteMatrix({
  refundTo,
  recipient,
  amount = "1000000",
  dry = true,
  allowFunded = false,
  balances = {},
} = {}) {
  const dest = TIDEPOOL_WNEAR;
  const candidates = [
    { id: "eth_sepolia_usdc_to_wnear", evm: TIDEPOOL_EVM.eth },
    { id: "arb_sepolia_usdc_to_wnear", evm: TIDEPOOL_EVM.arb },
    { id: "base_sepolia_usdc_to_wnear", evm: TIDEPOOL_EVM.base },
  ];
  const rows = [];
  for (const c of candidates) {
    const bal = balances[c.evm.origin_asset];
    const capital_ok = bal?.verified === true && BigInt(bal.amount_raw || "0") >= BigInt(amount);
    const q = await tidepoolQuote(
      {
        originAsset: c.evm.origin_asset,
        destinationAsset: dest,
        amount,
        refundTo,
        recipient,
      },
      { dry, allowFunded }
    );
    rows.push({
      id: c.id,
      chain_id: c.evm.chain_id,
      origin_asset: c.evm.origin_asset,
      destination_asset: dest,
      capital_ok,
      capital: bal || { reason: "no_balance_entry" },
      quote_ok: q.ok,
      reason: q.ok ? null : q.reason,
      amount_out: q.amount_out || null,
      min_amount_out: q.min_amount_out || null,
      amount_out_usd_display_only: q.amount_out_usd_display_only || null,
      deposit_address: q.deposit_address || null,
      correlation_id: q.correlation_id || null,
    });
  }
  const executable = rows.filter((r) => r.quote_ok && r.capital_ok);
  // Prefer higher min_amount_out (precise), not amountOutUsd
  executable.sort((a, b) =>
    BigInt(b.min_amount_out || "0") > BigInt(a.min_amount_out || "0") ? 1 : -1
  );
  return {
    ok: true,
    trust: TIDEPOOL_TRUST,
    dry,
    matrix: rows,
    proposal:
      executable.length === 0
        ? {
            choice: "NO_TRADE",
            rationale:
              "No Tidepool candidate with verified capital + successful quote",
          }
        : {
            choice: "TRADE",
            route_id: executable[0].id,
            origin_asset: executable[0].origin_asset,
            destination_asset: dest,
            amount,
            min_amount_out: executable[0].min_amount_out,
            rationale:
              "Selected by highest minAmountOut among capital-verified quotes; amountOutUsd not used as authority",
            funded_execution: dry ? "DISABLED" : "QUOTE_ONLY_PENDING_BROADCAST",
          },
  };
}
