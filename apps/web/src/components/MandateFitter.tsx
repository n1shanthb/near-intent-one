import type { GateJDecisionRecord, MandateSourceKind } from "../types/gateJ";
import { usdcDisplay } from "../lib/mandateFitter";

function mandateSourceLabel(source: MandateSourceKind | undefined) {
  switch (source) {
    case "authoritative_onchain":
      return { text: "Authoritative on-chain mandate", cls: "badge-pass" };
    case "recorded_evidence":
      return { text: "Recorded evidence", cls: "badge-recorded" };
    case "demo_fixture":
      return { text: "Demo fixture — not your live policy", cls: "badge-warn" };
    default:
      return { text: "Unavailable", cls: "badge-recorded" };
  }
}

export function MandateFitterPanel({
  record,
}: {
  record: GateJDecisionRecord | null;
}) {
  if (!record?.proposal || !record.mandate || !record.fit) {
    return (
      <section className="card">
        <div className="card-head">
          <h3>Mandate Fitter</h3>
          <span className="badge badge-warn">AWAITING RUN</span>
        </div>
        <p className="muted">
          Run Live AI or a fixture scenario to compare the original proposal, owner
          mandate, and deterministic Fitter result.
        </p>
      </section>
    );
  }

  const { proposal, mandate, fit } = record;
  const verdictClass =
    fit.verdict === "ALLOWED"
      ? "badge-pass"
      : fit.verdict === "ADAPTED"
        ? "badge-warn"
        : "badge-danger";
  const src = mandateSourceLabel(mandate.source);

  return (
    <section className="card">
      <div className="card-head">
        <h3>Mandate Fitter</h3>
        <span className={`badge ${verdictClass}`}>{fit.verdict}</span>
      </div>
      <p className="lede-tight">
        NIO finds the best viable version of an AI strategy within the owner&apos;s
        rules — NEAR enforces those rules.
      </p>
      <p className="muted small">
        Fitter <span className="mono">{fit.fitter_id}</span> · mode{" "}
        <strong>{fit.mode}</strong> · proposal source{" "}
        <strong>{proposal.source}</strong>
      </p>
      <p>
        <span className={`badge ${src.cls}`}>{src.text}</span>
      </p>

      <div className="fitter-grid">
        <div className="fitter-col">
          <h4>Original AI strategy</h4>
          <dl className="kv dense">
            <dt>Asset</dt>
            <dd className="mono">{proposal.asset}</dd>
            <dt>Proposed amount</dt>
            <dd>
              {proposal.amount_display ?? usdcDisplay(proposal.amount)}
              <div className="mono small muted">{proposal.amount}</div>
            </dd>
            <dt>Min viable size</dt>
            <dd>{usdcDisplay(proposal.min_viable_amount)}</dd>
            <dt>Thesis</dt>
            <dd>{proposal.thesis}</dd>
            <dt>Model</dt>
            <dd className="mono">{proposal.model ?? "—"}</dd>
          </dl>
        </div>

        <div className="fitter-col">
          <h4>Owner mandate</h4>
          <dl className="kv dense">
            <dt>Source</dt>
            <dd>
              <span className={`badge ${src.cls}`}>{mandate.source}</span>
              {mandate.source_detail ? (
                <div className="mono small muted">{mandate.source_detail}</div>
              ) : null}
            </dd>
            <dt>Portfolio</dt>
            <dd className="mono">{mandate.portfolio_id ?? "—"}</dd>
            <dt>Policy</dt>
            <dd className="mono small">
              {mandate.policy_contract ?? "—"}
              {mandate.policy_hash ? (
                <div>hash {mandate.policy_hash}</div>
              ) : null}
            </dd>
            <dt>Epoch</dt>
            <dd>{mandate.mandate_epoch}</dd>
            <dt>Freshness</dt>
            <dd className="mono small">
              {mandate.freshness_label ?? mandate.as_of ?? "—"}
            </dd>
            <dt>Approved assets</dt>
            <dd>{mandate.allowed_assets.join(", ")}</dd>
            <dt>Max trade size</dt>
            <dd>{usdcDisplay(mandate.max_trade_value)}</dd>
            <dt>Pending exposure cap</dt>
            <dd>{usdcDisplay(mandate.max_pending_exposure)}</dd>
          </dl>
          {mandate.source === "demo_fixture" ? (
            <p className="warn small">
              This is a demo fixture mandate — not the connected wallet&apos;s live
              on-chain policy.
            </p>
          ) : null}
        </div>

        <div className="fitter-col fitter-result">
          <h4>Fitter result</h4>
          <dl className="kv dense">
            <dt>Verdict</dt>
            <dd>
              <span className={`badge ${verdictClass}`}>{fit.verdict}</span>
            </dd>
            <dt>Final permitted amount</dt>
            <dd>{usdcDisplay(fit.final_amount)}</dd>
            <dt>Parameters changed</dt>
            <dd>
              {fit.parameters_changed.length === 0 ? (
                "none"
              ) : (
                <ul className="tight-list">
                  {fit.parameters_changed.map((p) => (
                    <li key={p.field}>
                      <span className="mono">{p.field}</span>: {usdcDisplay(p.from)} →{" "}
                      {usdcDisplay(p.to)}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>Constraints</dt>
            <dd>
              <ul className="tight-list">
                {fit.constraints_satisfied.map((c) => (
                  <li key={c.name}>
                    {c.ok ? "✓" : "✗"} {c.name}
                    {c.detail ? ` · ${c.detail}` : ""}
                  </li>
                ))}
              </ul>
            </dd>
            {fit.rejection_reasons.length > 0 ? (
              <>
                <dt>Rejection</dt>
                <dd>{fit.rejection_reasons.join("; ")}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </div>
    </section>
  );
}
