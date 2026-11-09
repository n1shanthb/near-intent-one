import type { OnChainPolicy } from "./schema";

/** Canonical JSON (sorted keys, stable arrays) for preview hashing — not a chain commitment. */
export function canonicalPolicyJson(policy: OnChainPolicy): string {
  const ordered = {
    allowed_assets: [...policy.allowed_assets].sort(),
    allowed_destinations: [...policy.allowed_destinations].sort(),
    daily_turnover_limit: policy.daily_turnover_limit,
    max_pending_exposure: policy.max_pending_exposure,
    max_slippage_bps: policy.max_slippage_bps,
    max_trade_value: policy.max_trade_value,
    valid_until: policy.valid_until,
  };
  return JSON.stringify(ordered);
}

export async function policyPreviewHash(policy: OnChainPolicy): Promise<string> {
  const data = new TextEncoder().encode(canonicalPolicyJson(policy));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
