/**
 * Gate I client — probes hosted API. Never fabricates portfolio/deposit/withdraw success.
 */
import type {
  AgentRuntimeState,
  BalanceSlice,
  CreatePortfolioRequest,
  CreatePortfolioResponse,
  DepositIntent,
  GateIHealthPayload,
  GateIStatus,
  PortfolioRecord,
  WithdrawLifecycleStage,
  WithdrawQuote,
  WithdrawReceipt,
  WithdrawRequest,
} from "../types/gateI";
import { WITHDRAW_LIFECYCLE_STAGES } from "../types/gateI";

const base = () =>
  (import.meta.env.VITE_GATE_I_API_BASE as string | undefined)?.replace(/\/$/, "") ??
  "";

/** Last successful health payload (for delivery-proven checks). */
let lastHealth: GateIHealthPayload | null = null;

async function getJson<T>(
  path: string,
  init?: RequestInit
): Promise<{ ok: true; data: T } | { ok: false; status: number; data: Record<string, unknown> }> {
  const root = base();
  if (!root) throw new Error("VITE_GATE_I_API_BASE unset");
  const res = await fetch(`${root}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { ok: false, status: res.status, data: body };
  return { ok: true, data: body as T };
}

export function gateIBaseConfigured(): boolean {
  return Boolean(base());
}

export function getConfiguredGateIBase(): string {
  return base();
}

export async function gateIHealth(): Promise<{
  status: GateIStatus;
  detail: string;
  payload?: GateIHealthPayload;
}> {
  if (!base()) {
    lastHealth = null;
    return {
      status: "unavailable",
      detail:
        "Gate I API base not configured (VITE_GATE_I_API_BASE). Personal portfolios blocked.",
    };
  }
  try {
    const res = await getJson<GateIHealthPayload>("/health");
    if (!res.ok) {
      lastHealth = null;
      return {
        status: "unavailable",
        detail:
          typeof res.data.reason === "string"
            ? res.data.reason
            : `Gate I HTTP ${res.status}`,
      };
    }
    lastHealth = res.data;
    if (res.data.ok) {
      return {
        status: "available",
        detail: `Gate I reachable · network ${res.data.network ?? "unknown"}`,
        payload: res.data,
      };
    }
    return {
      status: "degraded",
      detail: "Gate I health returned ok=false",
      payload: res.data,
    };
  } catch (e) {
    lastHealth = null;
    return {
      status: "unavailable",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function createPortfolio(
  req: CreatePortfolioRequest
): Promise<CreatePortfolioResponse> {
  const health = await gateIHealth();
  if (health.status !== "available") {
    return { status: "blocked", reason: health.detail };
  }
  const res = await getJson<CreatePortfolioResponse>("/portfolios", {
    method: "POST",
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const reason =
      typeof res.data.reason === "string"
        ? res.data.reason
        : `Gate I HTTP ${res.status}`;
    return { status: "blocked", reason };
  }
  return res.data;
}

export async function getPortfolio(
  id: string
): Promise<PortfolioRecord | null> {
  const health = await gateIHealth();
  if (health.status !== "available") return null;
  const res = await getJson<PortfolioRecord>(
    `/portfolios/${encodeURIComponent(id)}`
  );
  if (!res.ok) return null;
  return res.data;
}

export async function listBalances(id: string): Promise<BalanceSlice[]> {
  const health = await gateIHealth();
  if (health.status !== "available") return [];
  const res = await getJson<BalanceSlice[]>(
    `/portfolios/${encodeURIComponent(id)}/balances`
  );
  if (!res.ok) return [];
  return Array.isArray(res.data) ? res.data : [];
}

export async function createDeposit(input: {
  portfolio_id: string;
  chain: string;
  asset: string;
}): Promise<DepositIntent | { status: "blocked"; reason: string }> {
  const health = await gateIHealth();
  if (health.status !== "available") {
    return { status: "blocked", reason: health.detail };
  }
  const res = await getJson<DepositIntent>(
    `/portfolios/${encodeURIComponent(input.portfolio_id)}/deposits`,
    { method: "POST", body: JSON.stringify(input) }
  );
  if (!res.ok) {
    return {
      status: "blocked",
      reason:
        typeof res.data.reason === "string"
          ? res.data.reason
          : `Gate I HTTP ${res.status}`,
    };
  }
  return res.data;
}

export async function quoteWithdraw(
  req: WithdrawRequest
): Promise<WithdrawQuote> {
  const health = await gateIHealth();
  if (health.status !== "available") {
    return {
      ok: false,
      destination_valid: false,
      requires_owner_signature: true,
      blocked_reason: health.detail,
    };
  }
  const res = await getJson<WithdrawQuote>(
    `/portfolios/${encodeURIComponent(req.portfolio_id)}/withdrawals/quote`,
    { method: "POST", body: JSON.stringify(req) }
  );
  if (!res.ok) {
    return {
      ok: false,
      destination_valid: false,
      requires_owner_signature: true,
      blocked_reason:
        typeof res.data.blocked_reason === "string"
          ? res.data.blocked_reason
          : typeof res.data.reason === "string"
            ? res.data.reason
            : `Gate I HTTP ${res.status}`,
    };
  }
  return res.data;
}

export async function submitWithdraw(
  req: WithdrawRequest
): Promise<WithdrawReceipt> {
  const health = await gateIHealth();
  if (health.status !== "available") {
    return { status: "blocked", reason: health.detail };
  }
  if (!isWithdrawDeliveryEnabled()) {
    return {
      status: "blocked",
      reason:
        "Withdrawal delivery not proven. A NEAR withdraw_signed authorization is Signed only — not Broadcast/Confirmed/Received. Waiting on Chat 1 Sepolia receipt + destination balance evidence.",
    };
  }
  const res = await getJson<WithdrawReceipt>(
    `/portfolios/${encodeURIComponent(req.portfolio_id)}/withdrawals`,
    { method: "POST", body: JSON.stringify(req) }
  );
  if (!res.ok) {
    return {
      status: "blocked",
      reason:
        typeof res.data.reason === "string"
          ? res.data.reason
          : `Gate I HTTP ${res.status}`,
    };
  }
  return res.data;
}

export async function getAgentState(
  portfolioId: string
): Promise<AgentRuntimeState> {
  const health = await gateIHealth();
  if (health.status !== "available") {
    return {
      portfolio_id: portfolioId,
      running: false,
      strategy_id: null,
      last_decision: null,
      last_settlement: null,
      source: "unavailable",
    };
  }
  const res = await getJson<AgentRuntimeState>(
    `/portfolios/${encodeURIComponent(portfolioId)}/agent`
  );
  if (!res.ok) {
    return {
      portfolio_id: portfolioId,
      running: false,
      strategy_id: null,
      last_decision: null,
      last_settlement: null,
      source: "unavailable",
    };
  }
  return res.data;
}

export async function startAgent(
  portfolioId: string
): Promise<{ ok: boolean; reason?: string }> {
  const health = await gateIHealth();
  if (health.status !== "available") return { ok: false, reason: health.detail };
  const res = await getJson<{ ok: boolean; reason?: string }>(
    `/portfolios/${encodeURIComponent(portfolioId)}/agent/start`,
    { method: "POST", body: "{}" }
  );
  if (!res.ok) {
    return {
      ok: false,
      reason:
        typeof res.data.reason === "string"
          ? res.data.reason
          : `Gate I HTTP ${res.status}`,
    };
  }
  return res.data;
}

export async function stopAgent(
  portfolioId: string
): Promise<{ ok: boolean; reason?: string }> {
  const health = await gateIHealth();
  if (health.status !== "available") return { ok: false, reason: health.detail };
  const res = await getJson<{ ok: boolean; reason?: string }>(
    `/portfolios/${encodeURIComponent(portfolioId)}/agent/stop`,
    { method: "POST", body: "{}" }
  );
  if (!res.ok) {
    return {
      ok: false,
      reason:
        typeof res.data.reason === "string"
          ? res.data.reason
          : `Gate I HTTP ${res.status}`,
    };
  }
  return res.data;
}

/** Chat 1 sets this after GATE_I.md Sepolia withdraw receipt PASS. */
export function isWithdrawEnvFlagSet(): boolean {
  return import.meta.env.VITE_GATE_I_WITHDRAW_PROVEN === "true";
}

/**
 * Withdraw UX unlock: Chat 1 authorized env flag (GATE_I.md B2 PASS),
 * or live `/health.withdraw_delivery_proven` when the API exposes it.
 * Individual receipts still map Signed ≠ Received unless sepolia + dest confirmed.
 */
export function isWithdrawDeliveryEnabled(): boolean {
  return (
    isWithdrawEnvFlagSet() || lastHealth?.withdraw_delivery_proven === true
  );
}

/** @deprecated Prefer isWithdrawDeliveryEnabled — kept for older call sites. */
export function isWithdrawProven(): boolean {
  return isWithdrawDeliveryEnabled();
}

export function mapWithdrawToLifecycle(
  receipt: WithdrawReceipt | null,
  opts?: { nearSignedOnly?: boolean }
): WithdrawLifecycleStage | null {
  if (opts?.nearSignedOnly) return "Signed";
  if (!receipt) return null;
  const delivery = isWithdrawDeliveryEnabled();
  switch (receipt.status) {
    case "blocked":
      return "Requested";
    case "pending":
      return "Authorized";
    case "submitted":
      // NEAR function-call / signed preimage — not Sepolia delivery
      return receipt.sepolia_tx ? "Broadcast" : "Signed";
    case "failed":
    case "refunded":
      return "Signed";
    case "settled":
      if (
        delivery &&
        receipt.destination_balance_confirmed &&
        receipt.sepolia_tx
      ) {
        return "Received";
      }
      if (receipt.sepolia_tx) return "Confirmed";
      return "Signed";
    default:
      return "Requested";
  }
}

export function lifecycleIndex(stage: WithdrawLifecycleStage | null): number {
  if (!stage) return -1;
  return WITHDRAW_LIFECYCLE_STAGES.indexOf(stage);
}

export { WITHDRAW_LIFECYCLE_STAGES };
