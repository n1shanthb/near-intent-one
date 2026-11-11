#!/usr/bin/env node
/**
 * Production 1Click dry quote. Requires NIO_1CLICK_JWT for authenticated endpoints.
 * Never sets dry:false.
 */
import {
  fetchProductionTokens,
  productionDryQuote,
} from "../../packages/mainnet/intents.mjs";
import { MAINNET } from "../../packages/networks/profiles.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

const tokens = await fetchProductionTokens();
console.log(
  JSON.stringify(
    {
      tokens_ok: tokens.ok,
      tokens_count: tokens.count,
      reason: tokens.reason || null,
      http_status: tokens.status || null,
    },
    null,
    2
  )
);

const origin =
  arg("origin") ||
  process.env.NIO_MAINNET_ORIGIN_ASSET ||
  MAINNET.intents.exampleOriginAsset;
const dest =
  arg("dest") ||
  process.env.NIO_MAINNET_DEST_ASSET ||
  MAINNET.intents.exampleDestAsset;
const amount = arg("amount", "1000000"); // 1 USDC if 6 decimals
const refundTo = arg(
  "refund",
  process.env.NIO_MAINNET_REFUND || "0x2527D02599Ba641c19FEa793cD0F167589a0f10D"
);
const recipient = arg(
  "recipient",
  process.env.NIO_MAINNET_RECIPIENT || refundTo
);

const quote = await productionDryQuote({
  originAsset: origin,
  destinationAsset: dest,
  amount,
  refundTo,
  recipient,
  slippageTolerance: Number(arg("slippage", "100")),
});

console.log(JSON.stringify(quote, null, 2));
if (!quote.ok) process.exitCode = 2;
