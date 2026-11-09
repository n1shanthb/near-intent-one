import type { CandidatePolicy, OnChainPolicy } from "./schema";
import { CONSTRAINT_META } from "./schema";

export type DiffRow = {
  field: string;
  before: string;
  after: string;
  constraintClass: "enforced" | "planned";
  note: string;
};

export function policyDiff(
  before: Partial<OnChainPolicy> | null,
  after: CandidatePolicy
): DiffRow[] {
  const rows: DiffRow[] = [];
  const keys: (keyof OnChainPolicy)[] = [
    "max_trade_value",
    "daily_turnover_limit",
    "max_pending_exposure",
    "max_slippage_bps",
    "allowed_assets",
    "allowed_destinations",
    "valid_until",
  ];

  for (const key of keys) {
    const b = before?.[key];
    const a = after[key];
    const beforeStr = b == null ? "(unset)" : Array.isArray(b) ? b.join(", ") : String(b);
    const afterStr = Array.isArray(a) ? a.join(", ") : String(a);
    if (beforeStr === afterStr) continue;
    const meta = CONSTRAINT_META[key];
    rows.push({
      field: key,
      before: beforeStr,
      after: afterStr,
      constraintClass: meta.class,
      note: meta.note,
    });
  }

  if (after.max_drawdown_bps != null) {
    rows.push({
      field: "max_drawdown_bps",
      before: "(unsupported on-chain)",
      after: String(after.max_drawdown_bps),
      constraintClass: "planned",
      note: CONSTRAINT_META.max_drawdown_bps.note,
    });
  }

  return rows;
}
