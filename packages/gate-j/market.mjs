/**
 * Gate J — market snapshot with named sources + timestamps (fail closed if stale).
 * Live path pulls CoinGecko NEAR/USD — never invents mid prices.
 */
import { nowIso } from "./types.mjs";

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const COINGECKO_SIMPLE =
  "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true";

/**
 * Build a market snapshot. Live path uses CoinGecko + Tidepool ping; fixtures inject data.
 */
export async function fetchMarketSnapshot({
  tidepoolUrl = process.env.TIDEPOOL_URL || "https://www.usetidepool.tech",
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  fixture = null,
} = {}) {
  if (fixture) {
    const as_of = fixture.as_of || nowIso();
    const age = Date.now() - Date.parse(as_of);
    return {
      ...fixture,
      as_of,
      stale: fixture.stale === true || (Number.isFinite(age) && age > maxAgeMs),
      reason: fixture.stale ? fixture.reason || "fixture_marked_stale" : undefined,
      sources: fixture.sources || [{ name: "fixture", as_of }],
    };
  }

  const as_of = nowIso();
  const sources = [];
  let near_usd = null;
  let near_change_24h = null;
  let coingecko_updated_at = null;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(COINGECKO_SIMPLE, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(t);
    if (!res.ok) {
      sources.push({
        name: "coingecko",
        url: COINGECKO_SIMPLE,
        ok: false,
        http_status: res.status,
        as_of,
      });
    } else {
      const json = await res.json();
      near_usd = Number(json?.near?.usd);
      near_change_24h = Number(json?.near?.usd_24h_change);
      const lastUpdated = Number(json?.near?.last_updated_at);
      coingecko_updated_at = Number.isFinite(lastUpdated)
        ? new Date(lastUpdated * 1000).toISOString()
        : as_of;
      sources.push({
        name: "coingecko",
        url: "https://api.coingecko.com/api/v3/simple/price",
        ok: Number.isFinite(near_usd),
        http_status: res.status,
        as_of: coingecko_updated_at,
        fields: ["near.usd", "near.usd_24h_change", "near.last_updated_at"],
      });
    }
  } catch (e) {
    sources.push({
      name: "coingecko",
      url: "https://api.coingecko.com/api/v3/simple/price",
      ok: false,
      error: String(e.message || e).slice(0, 120),
      as_of,
    });
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${tidepoolUrl}/v0/health`, {
      signal: ctrl.signal,
    }).catch(() => fetch(tidepoolUrl, { signal: ctrl.signal, method: "HEAD" }));
    clearTimeout(t);
    sources.push({
      name: "tidepool",
      url: tidepoolUrl,
      ok: !!(res && (res.ok || res.status === 405 || res.status === 404)),
      http_status: res?.status ?? null,
      as_of,
      note: "connectivity/freshness probe — not a price oracle",
    });
  } catch (e) {
    sources.push({
      name: "tidepool",
      url: tidepoolUrl,
      ok: false,
      error: String(e.message || e).slice(0, 120),
      as_of,
    });
  }

  sources.push({
    name: "static_usdc_parity",
    note: "USDC treated as $1 testnet estimate only",
    as_of,
    ok: true,
  });

  const priceOk = sources.some((s) => s.name === "coingecko" && s.ok);
  const anyOk = priceOk || sources.some((s) => s.ok);
  // Rough vol proxy from 24h change when available
  const volProxy =
    Number.isFinite(near_change_24h) && near_change_24h !== 0
      ? Math.min(500, Math.round(Math.abs(near_change_24h) * 100))
      : 80;

  return {
    as_of,
    pair: { origin: "USDC", destination: "wNEAR" },
    network: "sepolia+intents",
    usdc_usd: 1,
    near_usd: Number.isFinite(near_usd) ? near_usd : null,
    near_change_24h_pct: Number.isFinite(near_change_24h) ? near_change_24h : null,
    volatility_bps_1h: volProxy,
    liquidity_score: priceOk ? 0.75 : 0.4,
    sources,
    stale: !priceOk,
    reason: priceOk ? undefined : "no_fresh_price_source",
    max_age_ms: maxAgeMs,
  };
}

export function assertMarketFresh(market, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!market?.as_of) return { ok: false, reason: "missing_as_of" };
  if (market.stale) return { ok: false, reason: market.reason || "stale" };
  const age = Date.now() - Date.parse(market.as_of);
  if (!Number.isFinite(age) || age > maxAgeMs) {
    return { ok: false, reason: "market_too_old", age_ms: age };
  }
  return { ok: true, age_ms: age };
}
