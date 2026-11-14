/**
 * Mock Marketplace Adapter
 * Agent service discovery, purchase, delivery, receipts.
 * Separate commerce balance from trading.
 * 
 * NO real HTTP to unknown endpoints unless documented as mock.
 */

import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";

/**
 * Mock service catalog.
 */
const MOCK_PROVIDERS = [
  {
    provider_id: "coingecko_mock",
    name: "CoinGecko Mock",
    services: [
      { service_id: "price_feed", price_usd_micros: "100000", ttl_sec: 300 },
    ],
    verified: true,
  },
  {
    provider_id: "defillama_mock",
    name: "DefiLlama Mock",
    services: [
      { service_id: "tvl_data", price_usd_micros: "200000", ttl_sec: 600 },
    ],
    verified: true,
  },
];

/**
 * Discover providers matching mandate allowlist.
 * 
 * @param {object} mandate
 * @returns {Promise<object[]>} providers
 */
export async function discoverProviders(mandate) {
  const allowlist = mandate.provider_allowlist || [];
  if (!allowlist.length) {
    return MOCK_PROVIDERS.filter((p) => p.verified);
  }
  return MOCK_PROVIDERS.filter((p) => allowlist.includes(p.provider_id));
}

/**
 * Quote service purchase.
 * 
 * @param {string} provider_id
 * @param {string} service_id
 * @returns {Promise<object>} quote
 */
export async function quoteService(provider_id, service_id) {
  const provider = MOCK_PROVIDERS.find((p) => p.provider_id === provider_id);
  if (!provider) {
    throw new Error("provider_not_found");
  }

  const service = provider.services.find((s) => s.service_id === service_id);
  if (!service) {
    throw new Error("service_not_found");
  }

  return {
    provider_id,
    service_id,
    price_usd_micros: service.price_usd_micros,
    ttl_sec: service.ttl_sec,
    quote_id: createQuoteId(provider_id, service_id),
    valid_until_ms: Date.now() + 60_000, // 1 min
  };
}

function createQuoteId(provider_id, service_id) {
  const payload = `${provider_id}:${service_id}:${Date.now()}`;
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 12);
}

/**
 * Match mandate to available services.
 * 
 * @param {object} mandate
 * @returns {Promise<object[]>} matches
 */
export async function matchMandate(mandate) {
  const providers = await discoverProviders(mandate);
  const matches = [];

  for (const provider of providers) {
    for (const service of provider.services) {
      const price_micros = BigInt(service.price_usd_micros);
      const max_purchase = BigInt(mandate.max_marketplace_purchase_raw || "0");

      if (price_micros <= max_purchase) {
        matches.push({
          provider_id: provider.provider_id,
          service_id: service.service_id,
          price_usd_micros: service.price_usd_micros,
          affordable: true,
        });
      }
    }
  }

  return matches;
}

/**
 * Check commerce balance.
 * Separate from trading balance.
 * 
 * @param {object} state
 * @returns {object} balance info
 */
export function checkCommerceBalance(state) {
  const spent = BigInt(state.commerce_spent_raw || "0");
  const budget = BigInt(state.commerce_budget_raw || "0");
  const remaining = budget - spent;

  return {
    spent_raw: spent.toString(),
    budget_raw: budget.toString(),
    remaining_raw: remaining.toString(),
    exhausted: remaining <= 0n,
  };
}

/**
 * Reserve budget for a purchase (optimistic lock).
 * 
 * @param {object} state
 * @param {string} amount_usd_micros
 * @returns {object} reservation
 */
export function reserveBudget(state, amount_usd_micros) {
  const amount = BigInt(amount_usd_micros);
  const balance = checkCommerceBalance(state);

  if (BigInt(balance.remaining_raw) < amount) {
    return { ok: false, reason: "insufficient_commerce_balance" };
  }

  const reservation_id = createHash("sha256")
    .update(`${Date.now()}:${amount}`, "utf8")
    .digest("hex")
    .slice(0, 16);

  return {
    ok: true,
    reservation_id,
    amount_usd_micros: amount.toString(),
    expires_at_ms: Date.now() + 5 * 60_000, // 5 min
  };
}

/**
 * Create purchase operation (mock).
 * 
 * @param {object} quote
 * @param {object} reservation
 * @returns {object} purchase op
 */
export function createPurchaseOp(quote, reservation) {
  return {
    op_id: createHash("sha256")
      .update(`${quote.quote_id}:${reservation.reservation_id}`, "utf8")
      .digest("hex")
      .slice(0, 16),
    provider_id: quote.provider_id,
    service_id: quote.service_id,
    price_usd_micros: quote.price_usd_micros,
    reservation_id: reservation.reservation_id,
    status: "PENDING",
    created_at_ms: Date.now(),
  };
}

/**
 * Confirm payment (mock).
 * 
 * @param {object} op
 * @returns {Promise<object>} confirmation
 */
export async function confirmPayment(op) {
  // Mock payment confirmation
  return {
    op_id: op.op_id,
    status: "CONFIRMED",
    confirmed_at_ms: Date.now(),
    tx_hash: "mock_tx_" + op.op_id,
  };
}

/**
 * Retrieve delivery (mock).
 * 
 * @param {object} op
 * @returns {Promise<object>} delivery
 */
export async function retrieveDelivery(op) {
  // Mock data delivery
  return {
    op_id: op.op_id,
    data: {
      prices: {
        NEAR: { usd: 5.0, btc: 0.00012 },
        USDC: { usd: 1.0, btc: 0.00002 },
      },
      timestamp_ms: Date.now(),
      source: `${op.provider_id}/${op.service_id}`,
    },
    delivered_at_ms: Date.now(),
  };
}

/**
 * Verify delivery integrity (mock).
 * 
 * @param {object} delivery
 * @returns {boolean} valid
 */
export function verifyDelivery(delivery) {
  // Mock verification
  return Boolean(delivery.data && delivery.delivered_at_ms);
}

/**
 * Store purchase receipts.
 * 
 * @param {object} journal
 * @param {object} op
 * @param {object} delivery
 */
export function storeReceipts(journal, op, delivery) {
  journal.append({
    kind: "commerce_purchase",
    op_id: op.op_id,
    provider_id: op.provider_id,
    service_id: op.service_id,
    price_usd_micros: op.price_usd_micros,
    status: "DELIVERED",
    delivered_at_ms: delivery.delivered_at_ms,
    data_hash: createHash("sha256")
      .update(JSON.stringify(delivery.data), "utf8")
      .digest("hex")
      .slice(0, 16),
  });
}

/**
 * Release or reconcile reservation.
 * 
 * @param {object} state
 * @param {object} reservation
 * @param {boolean} confirm - true to commit, false to release
 */
export function releaseOrReconcile(state, reservation, confirm) {
  if (confirm) {
    const spent = BigInt(state.commerce_spent_raw || "0");
    const amount = BigInt(reservation.amount_usd_micros);
    state.commerce_spent_raw = (spent + amount).toString();
  }
  // Otherwise, release without spending
}
