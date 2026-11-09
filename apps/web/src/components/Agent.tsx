import { useEffect, useState } from "react";
import { CONFIG } from "../lib/config";
import { F4_EXECUTION, FROZEN_POLICY, GATE_G_ACCOUNTING } from "../data/evidenceSnapshot";
import { gateHStrategy, type StrategyDecisionLog } from "../adapters/gateh";

export function AgentPanel() {
  const [strategy, setStrategy] = useState<StrategyDecisionLog | null>(null);

  useEffect(() => {
    void gateHStrategy.getLatestDecision().then(setStrategy);
  }, []);

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h3>Constrained agent</h3>
          <span className="badge badge-recorded">NO PRIVATE KEY</span>
        </div>
        <p>
          Agent <span className="mono">{CONFIG.agentAccount}</span> proposes under
          frozen owner policy. The <strong>policy contract</strong>{" "}
          <span className="mono">{CONFIG.policyContract}</span> owns the MPC path and
          requests Chain Signatures. Agent cannot set_policy, revoke, or choose an
          alternate EIP-155 digest.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Recorded F4 execution</h3>
          <span className="badge badge-pass">UNATTENDED PASS</span>
        </div>
        <dl className="kv dense">
          <dt>Operation</dt>
          <dd className="mono">{F4_EXECUTION.operationId}</dd>
          <dt>Quote / correlation</dt>
          <dd className="mono">{F4_EXECUTION.correlationId}</dd>
          <dt>Amount in</dt>
          <dd>
            {F4_EXECUTION.amountInDisplay} ({F4_EXECUTION.amountIn} base)
          </dd>
          <dt>Min out</dt>
          <dd className="mono">{F4_EXECUTION.minAmountOut}</dd>
          <dt>Deposit</dt>
          <dd className="mono">{F4_EXECUTION.depositAddress}</dd>
          <dt>Attestor</dt>
          <dd className="mono">{F4_EXECUTION.attestorPublicKey}</dd>
          <dt>Trust model</dt>
          <dd>{F4_EXECUTION.trustModel}</dd>
          <dt>Policy epoch</dt>
          <dd>
            {F4_EXECUTION.policyEpoch} · unchanged={String(F4_EXECUTION.policyUnchanged)}
          </dd>
          <dt>Tidepool</dt>
          <dd>{F4_EXECUTION.tidepoolStatus}</dd>
          <dt>Intents wNEAR</dt>
          <dd>{F4_EXECUTION.intentsWnearDisplay}</dd>
        </dl>

        <h4>On-chain constraints (frozen)</h4>
        <ul className="chip-row">
          <li>max trade {FROZEN_POLICY.max_trade_value}</li>
          <li>slippage {FROZEN_POLICY.max_slippage_bps} bps</li>
          <li>pending cap {FROZEN_POLICY.max_pending_exposure}</li>
        </ul>

        <h4>Proof chain</h4>
        <ol className="proof-ol">
          {F4_EXECUTION.steps.map((s) => (
            <li key={s.id}>
              <strong>{s.label}</strong> — {s.detail}
              {s.href && (
                <>
                  {" "}
                  <a href={s.href} target="_blank" rel="noreferrer">
                    explorer
                  </a>
                </>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Reconciler / exposure (Gate G)</h3>
          <span className="badge badge-pass">ACCOUNTING PASS</span>
        </div>
        <dl className="kv">
          <dt>Reserved</dt>
          <dd>{GATE_G_ACCOUNTING.snapshot.reserved_pending_exposure}</dd>
          <dt>Unresolved</dt>
          <dd>{GATE_G_ACCOUNTING.snapshot.unresolved_pending}</dd>
          <dt>Economically settled</dt>
          <dd>{String(GATE_G_ACCOUNTING.snapshot.economically_settled)}</dd>
          <dt>Reconciler</dt>
          <dd className="mono">{GATE_G_ACCOUNTING.reconciler}</dd>
        </dl>
        <p className="muted small">{GATE_G_ACCOUNTING.reconcileNote}</p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Strategy decision log</h3>
          <span className="badge badge-warn">AWAITING GATE H</span>
        </div>
        {strategy ? (
          <pre className="code">{JSON.stringify(strategy, null, 2)}</pre>
        ) : (
          <p className="muted">
            No AI decision trace invented. When Gate H emits genuine strategy
            logs (input → trade/no-trade → rationale → policy result → outcome),
            they will appear here.
          </p>
        )}
      </section>
    </div>
  );
}
