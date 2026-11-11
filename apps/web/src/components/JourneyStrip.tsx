import {
  buildOnboardingJourney,
  type JourneyInput,
  type JourneyStepStatus,
} from "../lib/onboardingJourney";
import type { NavId } from "./Shell";

const NAV_FOR_STEP: Record<string, NavId> = {
  connect_wallet: "welcome",
  verify_ownership: "welcome",
  create_portfolio: "portfolio",
  authorize_mandate: "policies",
  verify_contract: "portfolio",
  deposit: "funds",
  enable_agent: "agent",
  trade: "agent",
  withdraw: "funds",
};

const TONE: Record<JourneyStepStatus, string> = {
  READY: "journey-step done",
  PENDING: "journey-step",
  BLOCKED: "journey-step",
  UNSUPPORTED: "journey-step",
};

export function JourneyStrip({
  active,
  onNav,
  journeyInput,
}: {
  active: NavId;
  onNav: (id: NavId) => void;
  journeyInput?: JourneyInput;
}) {
  const steps = buildOnboardingJourney(
    journeyInput ?? {
      walletConnected: false,
      ownerVerified: false,
    }
  );

  return (
    <nav className="journey" aria-label="Product journey">
      {steps.map((step, i) => {
        const target = NAV_FOR_STEP[step.id] ?? "welcome";
        const on = active === target;
        return (
          <button
            key={step.id}
            type="button"
            className={on ? "journey-step on" : TONE[step.status]}
            onClick={() => onNav(target)}
            title={`${step.status}: ${step.detail}`}
          >
            <span className="journey-n">{i + 1}</span>
            {step.title}
            <span className="journey-status">{step.status}</span>
          </button>
        );
      })}
    </nav>
  );
}
