import type { NavId } from "./Shell";

const STEPS: { id: NavId; label: string }[] = [
  { id: "welcome", label: "Connect" },
  { id: "portfolio", label: "Portfolio" },
  { id: "funds", label: "Deposit" },
  { id: "policies", label: "Policy" },
  { id: "agent", label: "Agent" },
  { id: "activity", label: "Activity" },
  { id: "funds", label: "Withdraw" },
];

export function JourneyStrip({
  active,
  onNav,
}: {
  active: NavId;
  onNav: (id: NavId) => void;
}) {
  const activeIdx = (() => {
    if (active === "funds") return -1; // both Deposit and Withdraw share funds
    return STEPS.findIndex((s) => s.id === active);
  })();

  return (
    <nav className="journey" aria-label="Product journey">
      {STEPS.map((step, i) => {
        const isFunds = step.id === "funds";
        const on =
          active === step.id ||
          (isFunds && active === "funds") ||
          (activeIdx >= 0 && i <= activeIdx);
        return (
          <button
            key={`${step.label}-${i}`}
            type="button"
            className={active === step.id || (active === "funds" && isFunds) ? "journey-step on" : on ? "journey-step done" : "journey-step"}
            onClick={() => onNav(step.id)}
          >
            <span className="journey-n">{i + 1}</span>
            {step.label}
          </button>
        );
      })}
    </nav>
  );
}
