import { useEffect, useState } from "react";
import { CONFIG } from "../lib/config";
import {
  F4_EXECUTION,
  FROZEN_POLICY,
  GATE_G_ACCOUNTING,
  H3_DECISION,
  H3_EXECUTION,
} from "../data/evidenceSnapshot";
import { gateHStrategy, type StrategyDecisionLog } from "../adapters/gateh";

export function AgentPanel() {
  const [decision, setDecision] = useState<StrategyDecisionLog | null>(null);

  useEffect(() => {
    void gateHStrategy.getLatestDecision().then(setDecision);
  }, []);

  const d = decision ?? {
    ...H3_DECISION,
    execution: {
      operationId: H3_EXECUTION.operationId,
      mpcSignTx: H3_EXECUTION.mpcSignTx,
      sepoliaTx: H3_EXECUTION.sepoliaTx,
      tidepoolStatus: H3_EXECUTION.tidepoolStatus,
      reconcileTx: H3_EXECUTION.reconcileTx,
    },
  };

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h3>Constrained agent</h3>
          <span className="badge badge-recorded">NO PRIVATE KEY</span>
        </div>
        <p>
          Agent <span className="mono">{CONFIG.agentAccount}</span> proposes.
          Policy <span className="mono">{CONFIG.policyContract}</span> owns MPC.
          Reconciler <span className="mono">{GATE_G_ACCOUNTING.reconciler}</span> ≠
          agent (H2).
        </p>
      </section>

      <section className="card feature-card">
        <div className="card-head">
          <h3>H3 deterministic decision</h3>
          <span className="badge badge-pass">{d.choice}</span>
        </div>
        <p className="warn">
          Deterministic autonomous strategy — <strong>not</strong> LLM-generated
          trading intelligence. {H3_DECISION.ai_note}
        </p>
        <dl className="kv dense">
          <dt>Strategy</dt>
          <dd className="mono">{d.strategy_id}</dd>
          <dt>When</dt>
          <dd>{d.timestamp}</dd>
          <dt>Amount</dt>
          <dd>
            {d.amount_in} base ({H3_DECISION.amountInDisplay})
          </dd>
          <dt>Rationale</dt>
          <dd>{d.rationale}</dd>
          <dt>Correlation</dt>
          <dd className="mono">{d.quote_summary?.correlationId ?? "—"}</dd>
          <dt>Deposit</dt>
          <dd className="mono">{d.quote_summary?.depositAddress ?? "—"}</dd>
          <dt>Min out</dt>
          <dd className="mono">{d.quote_summary?.minAmountOut ?? "—"}</dd>
        </dl>
        <h4>Risk checks observed</h4>
        <ul className="chip-row">
          {d.checks.map((c) => (
            <li key={c.name}>
              {c.ok ? "✓" : "✗"} {c.name}
              {c.headroom != null ? ` · headroom ${String(c.headroom)}` : ""}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>H3 execution evidence</h3>
          <span className="badge badge-pass">SUCCESS</span>
        </div>
        <ol className="proof-ol">
          <li>
            Propose{" "}
            <a
              href={`${CONFIG.nearblocks}/txns/${H3_EXECUTION.proposeTx}`}
              target="_blank"
              rel="noreferrer"
            >
              {H3_EXECUTION.proposeTx.slice(0, 12)}…
            </a>
          </li>
          <li>
            MPC{" "}
            <a
              href={`${CONFIG.nearblocks}/txns/${H3_EXECUTION.mpcSignTx}`}
              target="_blank"
              rel="noreferrer"
            >
              {H3_EXECUTION.mpcSignTx.slice(0, 12)}…
            </a>
          </li>
          <li>
            Sepolia{" "}
            <a
              href={`${CONFIG.etherscan}/tx/${H3_EXECUTION.sepoliaTx}`}
              target="_blank"
              rel="noreferrer"
            >
              0xba28b97b…
            </a>{" "}
            status {H3_EXECUTION.sepoliaStatus}
          </li>
          <li>Tidepool {H3_EXECUTION.tidepoolStatus}</li>
          <li>
            Reconcile by {H3_EXECUTION.reconcileActor}{" "}
            <a
              href={`${CONFIG.nearblocks}/txns/${H3_EXECUTION.reconcileTx}`}
              target="_blank"
              rel="noreferrer"
            >
              {H3_EXECUTION.reconcileTx.slice(0, 12)}…
            </a>
          </li>
        </ol>
        <p className="muted small">
          Verification model: {H3_EXECUTION.verification}
        </p>
      </section>

      <section className="card">
        <h3>Policy constraints (frozen at trade time)</h3>
        <ul className="chip-row">
          <li>max trade {FROZEN_POLICY.max_trade_value}</li>
          <li>slippage {FROZEN_POLICY.max_slippage_bps} bps</li>
          <li>pending cap {FROZEN_POLICY.max_pending_exposure}</li>
        </ul>
        <p className="muted small">
          Earlier F4 cycle: {F4_EXECUTION.operationId} also SUCCESS under attestor
          trust.
        </p>
      </section>
    </div>
  );
}
