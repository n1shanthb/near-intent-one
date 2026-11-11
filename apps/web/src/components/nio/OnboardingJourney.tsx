import {
  buildOnboardingJourney,
  journeyTone,
  type JourneyInput,
  type JourneyStepStatus,
} from "../../lib/onboardingJourney";
import type { NavId } from "./nav";

const BADGE: Record<JourneyStepStatus, string> = {
  READY: "nio-badge-success",
  PENDING: "nio-badge-warn",
  BLOCKED: "nio-badge-danger",
  UNSUPPORTED: "nio-badge-idle",
};

export function OnboardingJourney({
  input,
  onNav,
  compact,
}: {
  input: JourneyInput;
  onNav?: (id: NavId) => void;
  compact?: boolean;
}) {
  const steps = buildOnboardingJourney(input);
  const operatorNeeded = steps.some((s) => s.operatorRequired);

  return (
    <section className={`axis-panel nio-onboarding-journey${compact ? " compact" : ""}`}>
      <div className="axis-panel-heading">
        <h2>Real-user onboarding</h2>
        <span className="nio-badge nio-badge-idle">DATA-DRIVEN</span>
      </div>
      <p className="axis-supporting">
        Connect → verify ownership → portfolio → mandate → contract → deposit →
        agent → trade → withdraw. Statuses are READY / BLOCKED / PENDING /
        UNSUPPORTED — never decorative success.
      </p>
      {operatorNeeded ? (
        <div className="nio-disclosure" style={{ marginTop: 10 }}>
          <strong>Operator action required.</strong> Portfolio provisioning is
          not self-serve on this host. Ownership verify alone does not create a
          funded custody account.
        </div>
      ) : null}
      <ol className="nio-journey-list">
        {steps.map((step, i) => (
          <li key={step.id} data-tone={journeyTone(step.status)}>
            <div className="nio-journey-row">
              <span className="nio-journey-n">{i + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.detail}</p>
              </div>
              <span className={`nio-badge ${BADGE[step.status]}`}>
                {step.status}
              </span>
            </div>
          </li>
        ))}
      </ol>
      {onNav ? (
        <div className="axis-actions" style={{ marginTop: 14, flexWrap: "wrap" }}>
          <button
            type="button"
            className="axis-button"
            onClick={() => onNav("owner")}
          >
            Verify ownership
          </button>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("my-portfolio")}
          >
            My portfolio
          </button>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("mainnet")}
          >
            Mainnet evidence
          </button>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("portfolio")}
          >
            Judge demo portfolio
          </button>
        </div>
      ) : null}
    </section>
  );
}
