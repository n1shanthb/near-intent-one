/**
 * Gate J — OpenRouter-only LLM adapter (OpenAI-compatible chat completions).
 * Never signs txs, mutates policy, or returns secrets in public config.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso } from "./types.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICES_ENV = join(PKG_ROOT, "packages", "services", ".env");

const ROLE_ENV = Object.freeze({
  researcher: "GATE_J_RESEARCH_MODEL",
  strategist: "GATE_J_STRATEGIST_MODEL",
  critic: "GATE_J_CRITIC_MODEL",
  copilot: "GATE_J_COPILOT_MODEL",
});

const ROLE_DEFAULTS = Object.freeze({
  researcher: "google/gemini-2.5-flash",
  strategist: "anthropic/claude-sonnet-4.6",
  critic: "openai/gpt-5.2",
  copilot: "google/gemini-2.5-flash",
});

/** Rough OpenRouter USD / 1M tokens for spend caps (estimates only). */
const PRICE_USD_PER_MTOK = Object.freeze({
  "google/gemini-2.5-flash": { prompt: 0.3, completion: 2.5 },
  "anthropic/claude-sonnet-4.6": { prompt: 3, completion: 15 },
  "openai/gpt-5.2": { prompt: 1.75, completion: 14 },
});

let envLoaded = false;
const spendState = { usd: 0, calls: 0 };

export function loadServicesEnv({ force = false } = {}) {
  if (envLoaded && !force) return;
  envLoaded = true;
  if (!existsSync(SERVICES_ENV)) return;
  const text = readFileSync(SERVICES_ENV, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function requireOpenRouterOnly() {
  loadServicesEnv();
  const provider = String(
    process.env.GATE_J_LLM_PROVIDER || "openrouter"
  ).toLowerCase();
  if (provider !== "openrouter") {
    const err = new Error(
      `GATE_J_LLM_PROVIDER=${provider} — only openrouter is supported`
    );
    err.code = "LLM_PROVIDER_UNSUPPORTED";
    throw err;
  }
  return provider;
}

export function getRoleModel(role) {
  loadServicesEnv();
  const envKey = ROLE_ENV[role];
  if (!envKey) throw new Error(`unknown_llm_role:${role}`);
  return process.env[envKey] || ROLE_DEFAULTS[role];
}

/**
 * Public-safe config (no API key). Safe for health / evidence.
 */
export function getLlmConfig() {
  loadServicesEnv();
  let provider = "openrouter";
  try {
    provider = requireOpenRouterOnly();
  } catch {
    provider = String(process.env.GATE_J_LLM_PROVIDER || "openrouter");
  }
  const apiKey = process.env.OPENROUTER_API_KEY || "";
  const baseUrl = (
    process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"
  ).replace(/\/$/, "");
  const timeoutMs = Number(process.env.GATE_J_LLM_TIMEOUT_MS || 60000);
  const maxRetries = Number(process.env.GATE_J_LLM_MAX_RETRIES || 2);
  const maxTokens = Number(process.env.GATE_J_LLM_MAX_TOKENS || 2048);
  const maxSpendUsd = Number(process.env.GATE_J_LLM_MAX_SPEND_USD || 1);
  return {
    provider,
    configured: Boolean(apiKey),
    base_url: baseUrl,
    models: {
      researcher: getRoleModel("researcher"),
      strategist: getRoleModel("strategist"),
      critic: getRoleModel("critic"),
      copilot: getRoleModel("copilot"),
    },
    timeout_ms: timeoutMs,
    max_retries: maxRetries,
    max_tokens: maxTokens,
    max_spend_usd: maxSpendUsd,
    spend_usd_session: Number(spendState.usd.toFixed(6)),
    calls_session: spendState.calls,
    // legacy aliases used by older traces
    model: getRoleModel("strategist"),
    timeoutMs,
  };
}

export function getSpendState() {
  return { ...spendState };
}

export function resetSpendState() {
  spendState.usd = 0;
  spendState.calls = 0;
}

function estimateCostUsd(model, usage) {
  const prices = PRICE_USD_PER_MTOK[model] || { prompt: 2, completion: 8 };
  const prompt = Number(usage?.prompt_tokens || usage?.input_tokens || 0);
  const completion = Number(
    usage?.completion_tokens || usage?.output_tokens || 0
  );
  return (prompt * prices.prompt + completion * prices.completion) / 1e6;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Extract JSON object from model content (fences / leading prose). */
export function parseJsonContent(content) {
  if (typeof content !== "string" || !content.trim()) {
    const err = new Error("LLM_EMPTY_CONTENT");
    err.code = "LLM_MALFORMED";
    throw err;
  }
  let text = content.trim();
  // Strip markdown fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    const err = new Error("LLM_JSON_PARSE");
    err.code = "LLM_MALFORMED";
    err.raw_slice = text.slice(0, 240);
    throw err;
  }
}

/**
 * @param {{
 *   role: "researcher"|"strategist"|"critic"|"copilot",
 *   system: string,
 *   user: string,
 *   temperature?: number,
 *   maxTokens?: number,
 * }} opts
 */
export async function chatJson(opts) {
  requireOpenRouterOnly();
  const cfg = getLlmConfig();
  if (!cfg.configured) {
    const err = new Error("LLM_NOT_CONFIGURED: set OPENROUTER_API_KEY");
    err.code = "LLM_NOT_CONFIGURED";
    throw err;
  }

  const role = opts.role || "strategist";
  const requestedModel = getRoleModel(role);
  const apiKey = process.env.OPENROUTER_API_KEY;
  const maxRetries = cfg.max_retries;
  const maxTokens =
    opts.maxTokens ??
    (role === "strategist" || role === "critic"
      ? Math.max(cfg.max_tokens, 3000)
      : cfg.max_tokens);

  if (spendState.usd >= cfg.max_spend_usd) {
    const err = new Error(
      `LLM_SPEND_CAP:${spendState.usd.toFixed(4)}>=${cfg.max_spend_usd}`
    );
    err.code = "LLM_SPEND_CAP";
    throw err;
  }

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeout_ms);
    const started = Date.now();
    try {
      const body = {
        model: requestedModel,
        temperature: opts.temperature ?? 0.2,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      };
      const res = await fetch(`${cfg.base_url}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://github.com/near-intent-one",
          "X-Title": "NIO Gate J",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`LLM_HTTP_${res.status}:${text.slice(0, 240)}`);
        err.code = "LLM_HTTP";
        err.status = res.status;
        // Retry transient 429/5xx
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          lastErr = err;
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw err;
      }
      const json = JSON.parse(text);
      const returnedModel = json.model || requestedModel;
      if (
        returnedModel &&
        !String(returnedModel).startsWith(requestedModel.split("/").pop()) &&
        returnedModel !== requestedModel &&
        !String(returnedModel).includes(requestedModel)
      ) {
        // Soft warning only — OpenRouter sometimes returns provider-prefixed ids
      }
      const message = json.choices?.[0]?.message || {};
      let content = message.content;
      // Some models return array content parts
      if (Array.isArray(content)) {
        content = content
          .map((p) => (typeof p === "string" ? p : p?.text || p?.content || ""))
          .join("\n");
      }
      if ((!content || typeof content !== "string") && message.refusal) {
        const err = new Error(`LLM_REFUSAL:${String(message.refusal).slice(0, 160)}`);
        err.code = "LLM_MALFORMED";
        throw err;
      }
      let parsed;
      try {
        parsed = parseJsonContent(content);
      } catch (parseErr) {
        // Persist raw slice for retries / diagnostics (never logs API key)
        parseErr.raw_slice = parseErr.raw_slice || String(content || "").slice(0, 240);
        throw parseErr;
      }

      const usage = json.usage || null;
      const costUsd = estimateCostUsd(requestedModel, usage || {});
      spendState.usd += costUsd;
      spendState.calls += 1;

      if (spendState.usd > cfg.max_spend_usd) {
        // Allow this call to complete, but next call will fail closed.
      }

      return {
        ok: true,
        parsed,
        raw: content,
        role,
        requested_model: requestedModel,
        model: returnedModel,
        provider: "openrouter",
        request_id:
          res.headers.get("x-request-id") ||
          json.id ||
          json.request_id ||
          null,
        latency_ms: Date.now() - started,
        timestamp: nowIso(),
        usage,
        estimated_cost_usd: Number(costUsd.toFixed(6)),
        spend_usd_session: Number(spendState.usd.toFixed(6)),
        attempt: attempt + 1,
      };
    } catch (e) {
      if (e.name === "AbortError") {
        lastErr = Object.assign(new Error("LLM_TIMEOUT"), {
          code: "LLM_TIMEOUT",
        });
        if (attempt < maxRetries) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw lastErr;
      }
      if (e.code === "LLM_MALFORMED" && attempt < maxRetries) {
        lastErr = e;
        await sleep(200 * (attempt + 1));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error("LLM_FAILED");
}
