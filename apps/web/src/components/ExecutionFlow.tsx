import { F4_EXECUTION } from "../data/evidenceSnapshot";

export function ExecutionFlow({ highlight = true }: { highlight?: boolean }) {
  return (
    <div className={`exec-flow ${highlight ? "hero-flow" : ""}`}>
      <div className="exec-flow-head">
        <p className="eyebrow">NEAR-native custody model</p>
        <h2>Policy owns the key. Agent never does.</h2>
        <p className="lede">
          Hardware owner sets rules → constrained agent proposes → quote attestor
          binds economics → <strong>NEAR policy contract</strong> requests MPC Chain
          Signature → Sepolia deposit → Intents settlement.
        </p>
      </div>
      <ol className="flow-rail">
        {F4_EXECUTION.steps.map((s, i) => (
          <li key={s.id} className="flow-node">
            <span className="flow-idx">{i + 1}</span>
            <div>
              <strong>{s.label}</strong>
              <p>{s.detail}</p>
              {s.href && (
                <a href={s.href} target="_blank" rel="noreferrer">
                  Open proof →
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
