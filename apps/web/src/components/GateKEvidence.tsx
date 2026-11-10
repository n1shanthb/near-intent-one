import { GATE_K_FIRST_TRADE, NEARBLOCKS_TX } from "../data/gateKEvidence";

/** Public judge panel — honest override disclosure. No acceptance controls. */
export function GateKEvidence() {
  const k = GATE_K_FIRST_TRADE;

  return (
    <section className="card">
      <div className="card-head">
        <h3>Gate K · first AI-directed Sepolia trade</h3>
        <span className="badge badge-pass">{k.labels.live_ai_execution}</span>
      </div>

      <p className="banner banner-block">
        <strong>{k.labels.autonomous_safety}</strong>
        <br />
        Fitter returned <span className="mono">ECONOMIC_NOT_VIABLE</span>. Critic
        returned <span className="mono">REJECT</span>. Pipeline decision was{" "}
        <span className="mono">NO_TRADE</span>. Execution happened only after an
        explicit one-time operator acceptance override — not exposed as a public
        demo control.
      </p>

      <dl className="kv dense">
        <dt>Portfolio</dt>
        <dd className="mono">{k.portfolio_id}</dd>
        <dt>Models</dt>
        <dd className="mono small">
          {k.models.researcher} · {k.models.strategist} · {k.models.critic}
        </dd>
        <dt>Strategist</dt>
        <dd>
          <span className="badge badge-pass">{k.ai.strategist_choice}</span> ·{" "}
          {k.proposed_usdc} USDC (cap {k.max_spend_usdc} USDC)
        </dd>
        <dt>Fitter</dt>
        <dd>
          <span className="badge badge-danger">{k.ai.fitter_outcome}</span> ·{" "}
          {k.ai.fitter_reasons.join(", ")}
        </dd>
        <dt>Critic</dt>
        <dd>
          <span className="badge badge-danger">{k.ai.critic_verdict}</span>
        </dd>
        <dt>Mandate</dt>
        <dd className="mono small">
          epoch {k.mandate.epoch} · {k.mandate.policy_hash} · autonomous_trading=
          {String(k.mandate.autonomous_trading)}
        </dd>
        <dt>Balances</dt>
        <dd>
          {k.balance_before_usdc} → {k.balance_after_usdc} USDC
        </dd>
        <dt>Sepolia</dt>
        <dd>
          <a href={k.execution.sepolia_explorer} target="_blank" rel="noreferrer">
            {k.execution.sepolia_tx.slice(0, 18)}…
          </a>{" "}
          status {k.execution.sepolia_status}
        </dd>
        <dt>NEAR MPC</dt>
        <dd className="proof-links">
          <a
            href={`${NEARBLOCKS_TX}/${k.execution.near_propose_tx}`}
            target="_blank"
            rel="noreferrer"
          >
            propose {k.execution.near_propose_tx.slice(0, 12)}…
          </a>
          <a
            href={`${NEARBLOCKS_TX}/${k.execution.near_sign_tx}`}
            target="_blank"
            rel="noreferrer"
          >
            sign {k.execution.near_sign_tx.slice(0, 12)}…
          </a>
        </dd>
        <dt>Tidepool</dt>
        <dd>{k.execution.tidepool_status}</dd>
        <dt>Reconcile</dt>
        <dd>
          {k.execution.reconcile_status} by{" "}
          <span className="mono">{k.execution.reconcile_actor}</span>{" "}
          <a
            href={`${NEARBLOCKS_TX}/${k.execution.reconcile_tx}`}
            target="_blank"
            rel="noreferrer"
          >
            {k.execution.reconcile_tx.slice(0, 12)}…
          </a>
        </dd>
      </dl>
      <p className="muted small">
        Recorded {k.authorized_at} · operation{" "}
        <span className="mono">{k.execution.operation_id}</span>. Public demo cannot
        invoke acceptance override or Gate K signing.
      </p>
    </section>
  );
}
