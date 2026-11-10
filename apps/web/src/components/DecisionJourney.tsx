import type { DecisionJourneyStage, GateJDecisionRecord } from "../types/gateJ";

const LABELS: Record<string, string> = {
  market_research: "1 · Market Research",
  ai_strategy: "2 · AI Strategy Proposal",
  mandate_fitting: "3 · Mandate Fitting",
  risk_review: "4 · Independent Risk Review",
  policy_validation: "5 · NEAR Policy Validation",
  execution: "6 · Execution / Enforcement",
  settlement: "7 · Settlement Verification",
};

function modeBadge(mode: GateJDecisionRecord["mode"] | undefined) {
  if (mode === "live_ai") return { cls: "badge-pass", text: "LIVE AI · DRY RUN" };
  if (mode === "fixture") return { cls: "badge-warn", text: "FIXTURE" };
  if (mode === "recorded") return { cls: "badge-recorded", text: "RECORDED" };
  return { cls: "badge-recorded", text: "IDLE" };
}

export function DecisionJourney({
  record,
}: {
  record: GateJDecisionRecord | null;
}) {
  const stages: DecisionJourneyStage[] =
    record?.stages ??
    (Object.keys(LABELS).map((id) => ({
      id: id as DecisionJourneyStage["id"],
      label: LABELS[id],
      status: "pending" as const,
    })) as DecisionJourneyStage[]);

  const badge = modeBadge(record?.mode);
  const blockedOk =
    record?.enforcement?.decision === "BLOCKED" &&
    record?.safety_story?.blocked_is_success;

  return (
    <section className="card">
      <div className="card-head">
        <h3>AI Decision Journey</h3>
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
      </div>

      {record?.safety_story ? (
        <div
          className={`safety-story ${blockedOk ? "safety-story-ok" : ""}`}
          role="status"
        >
          <p className="safety-headline">{record.safety_story.headline}</p>
          {blockedOk ? (
            <p className="muted small">
              <span className="badge badge-pass">BLOCKED · ENFORCED</span> This is a
              correct safety outcome — not an application failure.{" "}
              <span className="mono">may_sign=false</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {record?.models ? (
        <dl className="kv dense model-row">
          <dt>Models</dt>
          <dd className="mono small">
            Researcher {record.models.researcher ?? "—"} · Strategist{" "}
            {record.models.strategist ?? "—"} · Critic {record.models.critic ?? "—"}
          </dd>
        </dl>
      ) : null}

      <ol className="journey-stages">
        {stages.map((s) => (
          <li
            key={s.id}
            className={`stage stage-${s.status}${
              s.status === "enforced" ? " stage-enforced" : ""
            }`}
          >
            <div className="stage-head">
              <strong>{LABELS[s.id] ?? s.label}</strong>
              <span
                className={`badge ${
                  s.status === "enforced"
                    ? "badge-pass"
                    : s.status === "blocked"
                      ? "badge-warn"
                      : "badge-recorded"
                }`}
              >
                {s.status === "enforced" ? "enforced" : s.status}
              </span>
            </div>
            {s.detail ? <p className="muted small">{s.detail}</p> : null}
            {s.at ? <p className="mono small muted">{s.at}</p> : null}
          </li>
        ))}
      </ol>
      {record?.note ? <p className="muted small">{record.note}</p> : null}
    </section>
  );
}
