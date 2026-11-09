import { z } from "zod";

/**
 * On-chain PolicyLimits (contracts/policy) — ENFORCED when set via owner set_policy.
 * Units: token base units as decimal strings (U128 JSON).
 */
export const OnChainPolicySchema = z.object({
  max_trade_value: z
    .string()
    .regex(/^\d+$/, "max_trade_value must be unsigned integer string"),
  daily_turnover_limit: z
    .string()
    .regex(/^\d+$/, "daily_turnover_limit must be unsigned integer string"),
  max_pending_exposure: z
    .string()
    .regex(/^\d+$/, "max_pending_exposure must be unsigned integer string"),
  max_slippage_bps: z.number().int().min(0).max(10_000),
  allowed_assets: z.array(z.string().min(1)).min(1),
  allowed_destinations: z.array(z.string().min(1)).min(1),
  valid_until: z.string().regex(/^\d+$/, "valid_until ns timestamp string"),
});

export type OnChainPolicy = z.infer<typeof OnChainPolicySchema>;

/** Product-level intent — includes planned (not yet on-chain) constraints. */
export const CandidatePolicySchema = OnChainPolicySchema.extend({
  allowed_chains: z.array(z.enum(["ethereum", "near", "sepolia"])).min(1),
  /** Human display labels mapped to asset ids */
  display_tokens: z.array(z.string()).default([]),
  /** PLANNED — not enforced by current contract */
  max_drawdown_bps: z.number().int().min(0).max(10_000).optional(),
  /** PLANNED — not enforced by current contract */
  max_trades_per_day: z.number().int().min(1).max(10_000).optional(),
});

export type CandidatePolicy = z.infer<typeof CandidatePolicySchema>;

export type ConstraintClass = "enforced" | "planned";

export const CONSTRAINT_META: Record<
  keyof CandidatePolicy,
  { class: ConstraintClass; note: string }
> = {
  max_trade_value: {
    class: "enforced",
    note: "On-chain: reject propose when amount_in exceeds limit",
  },
  daily_turnover_limit: {
    class: "enforced",
    note: "On-chain field present; turnover accounting must stay consistent with contract",
  },
  max_pending_exposure: {
    class: "enforced",
    note: "On-chain reserved pending exposure cap",
  },
  max_slippage_bps: {
    class: "enforced",
    note: "On-chain min_amount_out vs amount_in bound",
  },
  allowed_assets: {
    class: "enforced",
    note: "On-chain asset allowlist (NEP-141 / OMFT ids)",
  },
  allowed_destinations: {
    class: "enforced",
    note: "On-chain destination allowlist (non-quoted path)",
  },
  valid_until: {
    class: "enforced",
    note: "On-chain mandate expiry (ns)",
  },
  allowed_chains: {
    class: "planned",
    note: "UI/compiler hint — contract uses asset ids, not chain enums",
  },
  display_tokens: {
    class: "planned",
    note: "Display mapping only",
  },
  max_drawdown_bps: {
    class: "planned",
    note: "Not in PolicyLimits — Copilot records intent for future enforcement",
  },
  max_trades_per_day: {
    class: "planned",
    note: "Not in PolicyLimits — Copilot records intent for future enforcement",
  },
};

/** Known testnet / demo asset ids used by Gates C–E */
export const KNOWN_ASSETS = {
  USDC_SEPOLIA_OMFT:
    "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet",
  WNEAR_TIDEPOOL: "nep141:wnear.tidepool-sandbox.testnet",
  NATIVE_NEAR: "near",
} as const;
