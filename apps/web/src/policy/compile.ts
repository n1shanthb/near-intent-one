import {
  CandidatePolicySchema,
  KNOWN_ASSETS,
  type CandidatePolicy,
} from "./schema";

export type CompileIssue = {
  severity: "error" | "warn";
  message: string;
};

export type CompileResult =
  | {
      ok: true;
      policy: CandidatePolicy;
      explanation: string[];
      issues: CompileIssue[];
      onChainPayload: {
        max_trade_value: string;
        daily_turnover_limit: string;
        max_pending_exposure: string;
        max_slippage_bps: number;
        allowed_assets: string[];
        allowed_destinations: string[];
        valid_until: string;
      };
    }
  | { ok: false; issues: CompileIssue[] };

const USDC_6 = (dollars: number) =>
  String(Math.round(dollars * 1_000_000));

function extractMoney(text: string, patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

function extractPct(text: string, patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

/**
 * Deterministic NL → policy compiler (no LLM).
 * Rejects ambiguous / impossible requests instead of guessing.
 */
export function compilePolicyFromText(
  input: string,
  opts?: { nowMs?: number; baselineDestinations?: string[] }
): CompileResult {
  const text = input.trim();
  const issues: CompileIssue[] = [];
  if (!text) {
    return { ok: false, issues: [{ severity: "error", message: "Empty request" }] };
  }
  const lower = text.toLowerCase();

  const chains: CandidatePolicy["allowed_chains"] = [];
  if (/\bethereum\b|\beth\b|\bsepolia\b/.test(lower)) chains.push("ethereum", "sepolia");
  if (/\bnear\b/.test(lower)) chains.push("near");
  const uniqChains = [...new Set(chains)] as CandidatePolicy["allowed_chains"];
  if (uniqChains.length === 0) {
    issues.push({
      severity: "error",
      message: "Name at least one chain (Ethereum/NEAR).",
    });
  }

  const tokens: string[] = [];
  if (/\busdc\b/.test(lower)) tokens.push("USDC");
  if (/\beth\b/.test(lower) && !/\bethereum\b/.test(lower.replace(/\beth\b/g, " "))) {
    /* eth as token often co-mentioned with ethereum — still allow ETH token */
  }
  if (/\beth\b/.test(lower)) tokens.push("ETH");
  if (/\bnear\b/.test(lower)) tokens.push("NEAR");
  const display_tokens = [...new Set(tokens)];
  if (display_tokens.length === 0) {
    issues.push({
      severity: "error",
      message: "Name allowed tokens (e.g. USDC, ETH, NEAR).",
    });
  }

  const maxTrade = extractMoney(lower, [
    /maximum\s*\$?\s*(\d+(?:\.\d+)?)\s*per\s*trade/,
    /max(?:imum)?\s*trade\s*(?:of\s*)?\$?\s*(\d+(?:\.\d+)?)/,
    /\$(\d+(?:\.\d+)?)\s*per\s*trade/,
  ]);
  const daily = extractMoney(lower, [
    /\$?\s*(\d+(?:\.\d+)?)\s*per\s*day/,
    /daily\s*(?:limit|turnover|cap)?\s*(?:of\s*)?\$?\s*(\d+(?:\.\d+)?)/,
  ]);
  const slip = extractPct(lower, [
    /(\d+(?:\.\d+)?)\s*%\s*slippage/,
    /slippage\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*%/,
  ]);
  const drawdown = extractPct(lower, [
    /(?:stop|halt|max(?:imum)?)\s*(?:at\s*)?(\d+(?:\.\d+)?)\s*%\s*drawdown/,
    /(\d+(?:\.\d+)?)\s*%\s*drawdown/,
  ]);

  if (maxTrade == null) {
    issues.push({
      severity: "error",
      message: "Specify a per-trade maximum (e.g. Maximum $10 per trade).",
    });
  }
  if (daily == null) {
    issues.push({
      severity: "error",
      message: "Specify a daily turnover limit (e.g. $50 per day).",
    });
  }
  if (slip == null) {
    issues.push({
      severity: "error",
      message: "Specify slippage percent (e.g. 1% slippage).",
    });
  }

  if (maxTrade != null && daily != null && maxTrade > daily) {
    issues.push({
      severity: "error",
      message: "Per-trade maximum cannot exceed daily turnover limit.",
    });
  }
  if (slip != null && (slip < 0 || slip > 50)) {
    issues.push({
      severity: "error",
      message: "Slippage must be between 0% and 50%.",
    });
  }

  if (issues.some((i) => i.severity === "error")) {
    return { ok: false, issues };
  }

  const now = opts?.nowMs ?? Date.now();
  const validUntilNs = String((now + 30 * 24 * 3600_000) * 1_000_000);

  const allowed_assets: string[] = [];
  if (display_tokens.includes("USDC")) allowed_assets.push(KNOWN_ASSETS.USDC_SEPOLIA_OMFT);
  if (display_tokens.includes("NEAR")) {
    allowed_assets.push(KNOWN_ASSETS.WNEAR_TIDEPOOL, KNOWN_ASSETS.NATIVE_NEAR);
  }
  // ETH as destination asset is not yet a Tidepool id in our evidence path — warn.
  if (display_tokens.includes("ETH")) {
    issues.push({
      severity: "warn",
      message:
        "ETH named: mapped as chain capability only until an OMFT/NEP-141 ETH asset id is configured.",
    });
  }
  if (allowed_assets.length === 0) {
    return {
      ok: false,
      issues: [
        ...issues,
        {
          severity: "error",
          message: "Could not map tokens to known on-chain asset ids.",
        },
      ],
    };
  }

  const destinations =
    opts?.baselineDestinations?.length
      ? opts.baselineDestinations
      : ["bob.testnet", "nio-c-owner-857107.testnet"];

  const max_trade_value = USDC_6(maxTrade!);
  const daily_turnover_limit = USDC_6(daily!);
  // Pending exposure defaults to daily cap unless stated.
  const max_pending_exposure = daily_turnover_limit;
  const max_slippage_bps = Math.round(slip! * 100);

  const draft = {
    max_trade_value,
    daily_turnover_limit,
    max_pending_exposure,
    max_slippage_bps,
    allowed_assets,
    allowed_destinations: destinations,
    valid_until: validUntilNs,
    allowed_chains: uniqChains,
    display_tokens,
    max_drawdown_bps:
      drawdown != null ? Math.round(drawdown * 100) : undefined,
  };

  const parsed = CandidatePolicySchema.safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        severity: "error" as const,
        message: `${i.path.join(".")}: ${i.message}`,
      })),
    };
  }

  const explanation = [
    `Chains: ${parsed.data.allowed_chains.join(", ")}.`,
    `Assets (enforced ids): ${parsed.data.allowed_assets.join(", ")}.`,
    `Max per trade: ${parsed.data.max_trade_value} base units (~$${maxTrade}).`,
    `Daily turnover: ${parsed.data.daily_turnover_limit} base units (~$${daily}).`,
    `Max pending exposure: ${parsed.data.max_pending_exposure} (defaults to daily).`,
    `Slippage: ${parsed.data.max_slippage_bps} bps (enforced).`,
    parsed.data.max_drawdown_bps != null
      ? `Drawdown stop ${parsed.data.max_drawdown_bps} bps — PLANNED, not on-chain yet.`
      : "No drawdown stop requested.",
    "This does not change the on-chain mandate. Owner must approve via Ledger handoff (Gate F).",
  ];

  return {
    ok: true,
    policy: parsed.data,
    explanation,
    issues,
    onChainPayload: {
      max_trade_value: parsed.data.max_trade_value,
      daily_turnover_limit: parsed.data.daily_turnover_limit,
      max_pending_exposure: parsed.data.max_pending_exposure,
      max_slippage_bps: parsed.data.max_slippage_bps,
      allowed_assets: parsed.data.allowed_assets,
      allowed_destinations: parsed.data.allowed_destinations,
      valid_until: parsed.data.valid_until,
    },
  };
}
