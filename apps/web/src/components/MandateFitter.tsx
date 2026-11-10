import type { GateJDecisionRecord, MandateSourceKind } from "../types/gateJ";
import { usdcDisplay } from "../lib/mandateFitter";

function mandateSourceLabel(source: MandateSourceKind | undefined) {
  switch (source) {
    case "authoritative_onchain":
      return { text: "Authoritative on-chain mandate", cls: "nio-badge nio-badge-success" };
    case "recorded_evidence":
      return { text: "Recorded evidence", cls: "nio-badge nio-badge-recorded" };
    case "demo_fixture":
      return { text: "Demo fixture — not live policy", cls: "nio-badge nio-badge-warn" };
    default:
      return { text: "Unavailable", cls: "nio-badge nio-badge-idle" };
  }
}

export function MandateFitterPanel({
  record,
}: {
  record: GateJDecisionRecord | null;
}) {
  if (!record?.proposal || !record.mandate || !record.fit) {
    return (
      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Mandate Fitter</h2>
          <span className="nio-badge nio-badge-idle">AWAITING RUN</span>
        </div>
        <div className="nio-empty-state">
          <p>
            After a run, this panel compares the original proposal, mandate
            constraints, and deterministic Fitter outcome.
          </p>
        </div>
      </section>
    );
  }

  const { proposal, mandate, fit } = record;
  const verdictClass =
    fit.verdict === "ALLOWED"
      ? "nio-badge nio-badge-success"
      : fit.verdict === "ADAPTED"
        ? "nio-badge nio-badge-warn"
        : "nio-badge nio-badge-danger";
  const src = mandateSourceLabel(mandate.source);

  return (
    <section className="axis-panel">
      <div className="axis-panel-heading">
        <h2>Mandate Fitter</h2>
        <span className={verdictClass}>{fit.verdict}</span>
      </div>
      <p className="axis-supporting" style={{ marginTop: -8, marginBottom: 14 }}>
        Deterministic fitter <span className="mono">{fit.fitter_id}</span> · mode{" "}
        <strong>{fit.mode}</strong> · <span className={src.cls}>{src.text}</span>
      </p>

      <div className="nio-fitter-grid">
        <div className="nio-fitter-col">
          <h3>Original proposal</h3>
          <dl className="nio-kv">
            <div>
              <dt>Asset</dt>
              <dd className="mono">{proposal.asset}</dd>
            </div>
            <div>
              <dt>Proposed</dt>
              <dd>
                {proposal.amount_display ?? usdcDisplay(proposal.amount)}
                <div className="mono axis-supporting">{proposal.amount}</div>
              </dd>
            </div>
            <div>
              <dt>Min viable</dt>
              <dd>{usdcDisplay(proposal.min_viable_amount)}</dd>
            </div>
            <div>
              <dt>Thesis</dt>
              <dd>{proposal.thesis}</dd>
            </div>
          </dl>
        </div>

        <div className="nio-fitter-col">
          <h3>Mandate constraints</h3>
          <dl className="nio-kv">
            <div>
              <dt>Portfolio</dt>
              <dd className="mono">{mandate.portfolio_id ?? "—"}</dd>
            </div>
            <div>
              <dt>Max trade</dt>
              <dd>{usdcDisplay(mandate.max_trade_value)}</dd>
            </div>
            <div>
              <dt>Assets</dt>
              <dd className="mono">{(mandate.allowed_assets ?? []).join(", ") || "—"}</dd>
            </div>
            <div>
              <dt>Epoch</dt>
              <dd className="mono">{mandate.mandate_epoch}</dd>
            </div>
          </dl>
        </div>

        <div className="nio-fitter-col nio-fitter-result">
          <h3>Fitter outcome</h3>
          <dl className="nio-kv">
            <div>
              <dt>Verdict</dt>
              <dd>
                <span className={verdictClass}>{fit.verdict}</span>
              </dd>
            </div>
            <div>
              <dt>Fitted amount</dt>
              <dd>
                {fit.final_amount != null
                  ? usdcDisplay(fit.final_amount)
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Reasons</dt>
              <dd>
                {fit.rejection_reasons.length
                  ? fit.rejection_reasons.join(", ")
                  : fit.parameters_changed.length
                    ? fit.parameters_changed
                        .map((p) => `${p.field}: ${p.from} → ${p.to}`)
                        .join("; ")
                    : "Within mandate"}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
