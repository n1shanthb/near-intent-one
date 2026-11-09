# Gate F → Product UI integration interface

Product UI defines adapters; Gate F owns implementations. Until Gate F exports these, UI shows **Pending Gate F** and never fakes success.

## Required from Gate F

```ts
export interface GateFLedgerHandoff {
  /** Prepare unsigned NEAR tx for set_policy / revoke — no secrets. */
  prepareOwnerCall(args: {
    method: "set_policy" | "revoke" | "unrevoke" | "set_trusted_quote_signer";
    args: Record<string, unknown>;
  }): Promise<{ requestId: string; summary: string; status: "ready_for_ledger" }>;

  /** Product never receives seed phrases. Status only. */
  awaitHardwareApproval(requestId: string): Promise<
    | { status: "signed"; nearTxHash: string }
    | { status: "rejected" | "blocked"; reason: string }
  >;
}

export interface GateFAgentCycle {
  /** Frozen-policy unattended cycle status (F4). */
  getLastUnattendedReceipt(): Promise<null | {
    operationId: string;
    correlationId: string;
    settlement: "Success" | "Failed" | "Refunded" | "Expired" | "Pending";
    nearProposeTx?: string;
    mpcSignTx?: string;
    evmBroadcastTx?: string;
    trustModel: "trusted_attestor";
  }>;
}

export interface GateFPolicySurface {
  /** Current on-chain PolicyLimits JSON as deployed. */
  getOnChainLimits(contractId: string): Promise<{
    max_trade_value: string;
    daily_turnover_limit: string;
    max_pending_exposure: string;
    max_slippage_bps: number;
    allowed_assets: string[];
    allowed_destinations: string[];
    valid_until: string;
  }>;
}
```

## Product promises

1. Copilot never submits `set_policy` from an LLM/compiler output alone.
2. Hardware approval always goes through `GateFLedgerHandoff`.
3. Demo steps 4–6 stay labeled **Pending Gate F** until receipts exist.
