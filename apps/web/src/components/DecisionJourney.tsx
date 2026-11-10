import type { DecisionJourneyStage, GateJDecisionRecord } from "../types/gateJ";

const LABELS: Record<string, string> = {
  market_research: "Market Research",
  ai_strategy: "AI Strategy",
  mandate_fitting: "Mandate Fitting",
  risk_review: "Risk Review",
  policy_validation: "NEAR Policy Guard",
  execution: "Enforcement",
  settlement: "Settlement",
};

function modeBadge(mode: GateJDecisionRecord["mode"] | undefined) {
  if (mode === "live_ai") return { cls: "nio-badge nio-badge-running", text: "LIVE AI · DRY RUN" };
  if (mode === "fixture") return { cls: "nio-badge nio-badge-warn", text: "FIXTURE" };
  if (mode === "recorded") return { cls: "nio-badge nio-badge-recorded", text: "RECORDED" };
  return { cls: "nio-badge nio-badge-idle", text: "IDLE" };
}

function statusClass(status: DecisionJourneyStage["status"]): string {
  switch (status) {
    case "done":
    case "enforced":
      return "nio-step-done";
    case "blocked":
      return "nio-step-blocked";
    case "skipped":
      return "nio-step-idle";
    default:
      return "nio-step-idle";
  }
}

export function DecisionJourney({
  record,
}: {
  record: GateJDecisionRecord | null;
}) {
  if (!record) {
    return (
      <section className="axis-panel nio-journey-panel">
        <div className="axis-panel-heading">
          <h2>Decision Journey</h2>
          <span className="nio-badge nio-badge-idle">IDLE</span>
        </div>
        <div className="nio-empty-state">
          <p>
            Run Live AI Analysis or a fixture scenario to populate the timeline.
            Idle agents do not show seven empty pending rows.
          </p>
        </div>
      </section>
    );
  }

  const stages = record.stages ?? [];
  const badge = modeBadge(record.mode);
  const blockedOk =
    record.enforcement?.decision === "BLOCKED" &&
    record.safety_story?.blocked_is_success;

  return (
    <section className="axis-panel nio-journey-panel">
      <div className="axis-panel-heading">
        <h2>Decision Journey</h2>
        <span className={badge.cls}>{badge.text}</span>
      </div>

      {record.safety_story ? (
        <div
          className={`nio-safety-story ${blockedOk ? "ok" : ""}`}
          role="status"
        >
          <p className="nio-safety-headline">{record.safety_story.headline}</p>
          {blockedOk ? (
            <p className="axis-supporting">
              <span className="nio-badge nio-badge-success">BLOCKED · ENFORCED</span>{" "}
              Correct safety outcome — not an application failure.{" "}
              <span className="mono">may_sign=false</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {record.models ? (
        <p className="axis-supporting mono" style={{ marginBottom: 14 }}>
          Researcher {record.models.researcher ?? "—"} · Strategist{" "}
          {record.models.strategist ?? "—"} · Critic {record.models.critic ?? "—"}
        </p>
      ) : null}

      <ol className="nio-timeline">
        {stages.map((s, i) => (
          <li key={s.id} className={`nio-timeline-step ${statusClass(s.status)}`}>
            <div className="nio-timeline-index">{i + 1}</div>
            <div className="nio-timeline-body">
              <div className="nio-timeline-head">
                <strong>{LABELS[s.id] ?? s.label}</strong>
                <span className="nio-badge nio-badge-idle">{s.status}</span>
              </div>
              {s.detail ? <p>{s.detail}</p> : null}
              {s.at ? <p className="mono axis-supporting">{s.at}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      {record.note ? <p className="axis-supporting">{record.note}</p> : null}
    </section>
  );
}
