/**
 * Persistent demo quotas for public Gate J LIVE AI DRY RUN.
 * Fail-closed if state file is unreadable/unwritable.
 * Survives process restarts; single-flight is in-process + stale lock TTL.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const DEFAULTS = Object.freeze({
  clientDailyLimit: 3,
  globalDailyLimit: 40,
  maxSpendUsd: 2,
  singleFlightTtlMs: 180_000,
  minIntervalMs: 15_000,
});

function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function demoQuotaConfig() {
  return {
    enabled: process.env.GATE_J_DEMO_ENABLED !== "0",
    portfolioId: process.env.GATE_J_DEMO_PORTFOLIO_ID || "i-a-a4e7",
    claimedOwner:
      process.env.GATE_J_DEMO_CLAIMED_OWNER || "nio-i-a4e7-a-owner.testnet",
    clientDailyLimit: numEnv(
      "GATE_J_DEMO_CLIENT_DAILY_LIMIT",
      DEFAULTS.clientDailyLimit
    ),
    globalDailyLimit: numEnv(
      "GATE_J_DEMO_GLOBAL_DAILY_LIMIT",
      DEFAULTS.globalDailyLimit
    ),
    maxSpendUsd: numEnv("GATE_J_DEMO_MAX_SPEND_USD", DEFAULTS.maxSpendUsd),
    killSwitch: process.env.GATE_J_DEMO_KILL_SWITCH === "1",
    timeoutMs: numEnv("GATE_J_DEMO_TIMEOUT_MS", 90_000),
    singleFlightTtlMs: numEnv(
      "GATE_J_DEMO_SINGLE_FLIGHT_TTL_MS",
      DEFAULTS.singleFlightTtlMs
    ),
    minIntervalMs: numEnv(
      "GATE_J_DEMO_MIN_INTERVAL_MS",
      DEFAULTS.minIntervalMs
    ),
  };
}

function emptyState(day = utcDay()) {
  return {
    version: 1,
    day,
    global_calls: 0,
    spend_usd: 0,
    clients: {},
    flight: null,
    updated_at: new Date().toISOString(),
  };
}

export function createDemoQuota({ dataDir, fileName = "gate-j-demo-quota.json" }) {
  if (!dataDir) {
    throw new Error("demo_quota_data_dir_required");
  }
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, fileName);
  let memFlight = null;

  function readState() {
    try {
      if (!existsSync(path)) {
        const s = emptyState();
        writeAtomic(s);
        return { ok: true, state: s };
      }
      const raw = readFileSync(path, "utf8");
      if (!raw.trim()) {
        return { ok: false, reason: "DEMO_QUOTA_UNAVAILABLE", detail: "empty_state" };
      }
      const state = JSON.parse(raw);
      if (!state || typeof state !== "object") {
        return { ok: false, reason: "DEMO_QUOTA_UNAVAILABLE", detail: "bad_state" };
      }
      const day = utcDay();
      if (state.day !== day) {
        const rolled = emptyState(day);
        // preserve kill/flight only if still valid — drop clients/spend on day roll
        writeAtomic(rolled);
        return { ok: true, state: rolled };
      }
      if (typeof state.global_calls !== "number" || typeof state.spend_usd !== "number") {
        return { ok: false, reason: "DEMO_QUOTA_UNAVAILABLE", detail: "corrupt_counters" };
      }
      if (!state.clients || typeof state.clients !== "object") state.clients = {};
      return { ok: true, state };
    } catch (e) {
      return {
        ok: false,
        reason: "DEMO_QUOTA_UNAVAILABLE",
        detail: e instanceof Error ? e.message.slice(0, 120) : "read_failed",
      };
    }
  }

  function writeAtomic(state) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const payload = {
      ...state,
      updated_at: new Date().toISOString(),
    };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, path);
  }

  function publicStatus(state, cfg = demoQuotaConfig()) {
    return {
      ok: true,
      enabled: cfg.enabled,
      kill_switch: cfg.killSwitch,
      day: state.day,
      portfolio_id: cfg.portfolioId,
      limits: {
        client_daily: cfg.clientDailyLimit,
        global_daily: cfg.globalDailyLimit,
        max_spend_usd: cfg.maxSpendUsd,
        min_interval_ms: cfg.minIntervalMs,
        single_flight_ttl_ms: cfg.singleFlightTtlMs,
        timeout_ms: cfg.timeoutMs,
      },
      usage: {
        global_calls: state.global_calls,
        spend_usd: Number(Number(state.spend_usd).toFixed(6)),
        flight_busy: Boolean(memFlight || (state.flight && Date.now() < state.flight.until)),
      },
      remaining: {
        global_calls: Math.max(0, cfg.globalDailyLimit - state.global_calls),
        spend_usd: Math.max(0, Number((cfg.maxSpendUsd - state.spend_usd).toFixed(6))),
      },
    };
  }

  function sanitizeClientKey(raw) {
    const s = String(raw || "anon")
      .split(",")[0]
      .trim()
      .slice(0, 64);
    return s || "anon";
  }

  /**
   * Acquire single-flight + check quotas. Fail-closed.
   * Caller MUST release via releaseFlight (finally).
   */
  function beginRequest({ clientKey } = {}) {
    const cfg = demoQuotaConfig();
    if (!cfg.enabled) {
      return { ok: false, reason: "DEMO_DISABLED" };
    }
    if (cfg.killSwitch) {
      return { ok: false, reason: "DEMO_KILL_SWITCH" };
    }

    const loaded = readState();
    if (!loaded.ok) return loaded;
    const state = loaded.state;
    const key = sanitizeClientKey(clientKey);
    const now = Date.now();

    // Stale flight cleanup
    if (state.flight && now >= state.flight.until) {
      state.flight = null;
    }
    if (memFlight && now >= memFlight.until) {
      memFlight = null;
    }
    if (memFlight || state.flight) {
      return {
        ok: false,
        reason: "DEMO_BUSY",
        retry_after_ms: Math.max(
          1000,
          (memFlight?.until || state.flight?.until || now) - now
        ),
      };
    }

    if (state.global_calls >= cfg.globalDailyLimit) {
      return {
        ok: false,
        reason: "DEMO_GLOBAL_DAILY_LIMIT",
        limit: cfg.globalDailyLimit,
        used: state.global_calls,
      };
    }
    if (state.spend_usd >= cfg.maxSpendUsd) {
      return {
        ok: false,
        reason: "DEMO_SPEND_CAP",
        limit_usd: cfg.maxSpendUsd,
        used_usd: Number(state.spend_usd.toFixed(6)),
      };
    }

    const client = state.clients[key] || { calls: 0, last_at: 0 };
    if (client.calls >= cfg.clientDailyLimit) {
      return {
        ok: false,
        reason: "DEMO_CLIENT_DAILY_LIMIT",
        limit: cfg.clientDailyLimit,
        used: client.calls,
        client_key_hash: hashKey(key),
      };
    }
    if (client.last_at && now - client.last_at < cfg.minIntervalMs) {
      return {
        ok: false,
        reason: "DEMO_CLIENT_COOLDOWN",
        retry_after_ms: cfg.minIntervalMs - (now - client.last_at),
        client_key_hash: hashKey(key),
      };
    }

    const until = now + cfg.singleFlightTtlMs;
    memFlight = { until, client: hashKey(key), started: now };
    state.flight = { until, client: hashKey(key), started: new Date(now).toISOString() };
    try {
      writeAtomic(state);
    } catch (e) {
      memFlight = null;
      return {
        ok: false,
        reason: "DEMO_QUOTA_UNAVAILABLE",
        detail: e instanceof Error ? e.message.slice(0, 120) : "write_failed",
      };
    }

    return {
      ok: true,
      client_key: key,
      client_key_hash: hashKey(key),
      spend_usd_before: state.spend_usd,
      max_spend_usd: cfg.maxSpendUsd,
      remaining_spend_usd: Math.max(0, cfg.maxSpendUsd - state.spend_usd),
      cfg,
      status: publicStatus(state, cfg),
    };
  }

  function releaseFlight({
    clientKey,
    spendUsdDelta = 0,
    counted = false,
  } = {}) {
    const loaded = readState();
    // Always clear memory flight
    memFlight = null;
    if (!loaded.ok) {
      return loaded;
    }
    const state = loaded.state;
    state.flight = null;
    // Always persist spend if LLM burned tokens (even on timeout/error).
    const delta = Number(spendUsdDelta) || 0;
    if (delta > 0) {
      state.spend_usd = Number((state.spend_usd + delta).toFixed(8));
    }
    if (counted) {
      const key = sanitizeClientKey(clientKey);
      const client = state.clients[key] || { calls: 0, last_at: 0 };
      client.calls += 1;
      client.last_at = Date.now();
      state.clients[key] = client;
      state.global_calls += 1;
    }
    try {
      writeAtomic(state);
      return { ok: true, status: publicStatus(state) };
    } catch (e) {
      return {
        ok: false,
        reason: "DEMO_QUOTA_UNAVAILABLE",
        detail: e instanceof Error ? e.message.slice(0, 120) : "write_failed",
      };
    }
  }

  function getStatus() {
    const cfg = demoQuotaConfig();
    const loaded = readState();
    if (!loaded.ok) return loaded;
    return publicStatus(loaded.state, cfg);
  }

  /** Test helper — replace state file. */
  function _resetForTests(partial = {}) {
    memFlight = null;
    const s = { ...emptyState(), ...partial };
    writeAtomic(s);
    return s;
  }

  return {
    path,
    beginRequest,
    releaseFlight,
    getStatus,
    readState,
    _resetForTests,
  };
}

function hashKey(key) {
  // Short non-reversible-ish fingerprint for logs (not crypto security).
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `c${(h >>> 0).toString(16)}`;
}

export function clientKeyFromMeta(meta = {}) {
  const fwd =
    meta.forwardedFor ||
    meta.xForwardedFor ||
    meta.realIp ||
    meta.ip ||
    "";
  return String(fwd).split(",")[0].trim() || "anon";
}
