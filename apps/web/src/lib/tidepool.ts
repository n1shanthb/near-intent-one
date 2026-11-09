import { CONFIG } from "./config";

export type DryQuote = {
  correlationId?: string;
  quote?: {
    depositAddress?: string;
    amountIn?: string;
    amountOut?: string;
    minAmountOut?: string;
    deadline?: string;
  };
  raw: unknown;
};

/** Real Tidepool quote with dry:true — no funds, no deposit address commitment required for preview. */
export async function fetchDryQuote(amountIn = "1000000"): Promise<DryQuote> {
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: CONFIG.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: CONFIG.destAsset,
    amount: amountIn,
    refundTo: CONFIG.mpcEvm,
    refundType: "ORIGIN_CHAIN",
    recipient: CONFIG.mpcEvm,
    recipientType: "INTENTS",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  };

  const res = await fetch(CONFIG.tidepoolQuotePath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.json();
  if (!res.ok) {
    throw new Error(`quote HTTP ${res.status}: ${JSON.stringify(raw)}`);
  }
  return {
    correlationId: raw.correlationId,
    quote: raw.quote,
    raw,
  };
}
