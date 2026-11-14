import { apiBase } from "../lib/apiBase";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const body = (await res.json()) as T & { ok?: boolean; reason?: string };
  if (!res.ok) {
    throw new Error((body as { reason?: string }).reason || `http_${res.status}`);
  }
  return body;
}

export type MainnetMandate = {
  ok: boolean;
  owner: string;
  agent: string;
  policy: string;
  portfolio_id: string;
  mandate_epoch: number;
  paused: boolean;
  revoked: boolean;
  autonomous_trading: boolean;
  enforce_autonomous_on_agent: boolean;
  state_version: number | { error?: unknown };
  limits: {
    max_trade_value: string;
    daily_turnover_limit: string;
    max_pending_exposure: string;
    max_slippage_bps: number;
    max_gas_budget: string;
    allowed_chains: string[];
    allowed_assets: string[];
    allowed_venues: string[];
    allowed_destinations: string[];
    valid_until: string;
    token_scope: string;
  };
  usage: {
    reserved_pending_exposure: string | number;
    daily_turnover?: string | { toString?: () => string };
    realized_exposure?: string | { toString?: () => string };
  };
  expiry: {
    expires_at_ms: number | null;
    expires_in_ms: number | null;
  };
  fetched_at: string;
  fresh: boolean;
};

export type MainnetDecisionSummary = {
  cycle_id: string;
  timestamp_ms: number;
  final_action: string;
  fitter_verdict: string;
  critic_verdict: string;
  reason_code: string;
  mandate_epoch: number;
  evidence_hash: string;
  decision_hash: string | null;
  status: string;
  near_tx: string | null;
  explorer: string | null;
};

export function fetchMainnetMandate() {
  return getJson<MainnetMandate>("/mainnet/mandate");
}

export function fetchMainnetAgent() {
  return getJson<Record<string, unknown>>("/mainnet/agent");
}

export function fetchMainnetDecisions(limit = 40) {
  return getJson<{ ok: boolean; decisions: MainnetDecisionSummary[] }>(
    `/mainnet/decisions?limit=${limit}`
  );
}

export function fetchMainnetDecision(cycleId: string) {
  return getJson<Record<string, unknown>>(
    `/mainnet/decisions/${encodeURIComponent(cycleId)}`
  );
}

export function fetchMainnetProof(cycleId: string) {
  return getJson<Record<string, unknown>>(
    `/mainnet/proof/${encodeURIComponent(cycleId)}`
  );
}

export function fetchMainnetTransactions() {
  return getJson<{
    ok: boolean;
    governance: { kind: string; tx: string; explorer: string; label: string }[];
    autonomous_settled_trades: unknown[];
    supervised_canaries_note: string;
  }>("/mainnet/transactions");
}

export function usdcLabel(raw: string | number | undefined | null): string {
  if (raw == null) return "—";
  const n = typeof raw === "string" ? Number(raw) : Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  return `$${(n / 1e6).toFixed(2)} USDC`;
}

export function chainBadge(id: string): { label: string; tone: string } {
  if (id === "near") return { label: "NEAR", tone: "near" };
  if (id === "eip155:1") return { label: "Ethereum", tone: "eth" };
  if (id === "eip155:42161") return { label: "Arbitrum", tone: "arb" };
  if (id === "eip155:8453") return { label: "Base", tone: "base" };
  return { label: id, tone: "other" };
}
