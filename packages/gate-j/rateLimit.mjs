/**
 * Simple in-memory rate + cost gates for Gate J hosted LLM routes.
 */
const buckets = new Map();

export function rateLimitCheck({
  key,
  limit = Number(process.env.GATE_J_RATE_LIMIT_PER_MIN || 10),
  windowMs = 60_000,
}) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.windowStart >= windowMs) {
    b = { windowStart: now, count: 0 };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) {
    return {
      ok: false,
      reason: "RATE_LIMIT",
      limit,
      retry_after_ms: windowMs - (now - b.windowStart),
    };
  }
  return { ok: true, remaining: limit - b.count };
}

export function resetRateLimits() {
  buckets.clear();
}
