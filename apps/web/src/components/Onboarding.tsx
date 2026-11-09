import type { NavId } from "./Shell";

export function Onboarding({
  onNav,
  onSignIn,
  walletConnected,
}: {
  onNav: (id: NavId) => void;
  onSignIn: () => void;
  walletConnected: boolean;
}) {
  return (
    <section className="card onboarding">
      <p className="eyebrow">Choose how to enter</p>
      <h2>Three paths. No false hardware claims.</h2>
      <div className="onboard-grid">
        <button type="button" className="onboard-card" onClick={() => onNav("ledger")}>
          <strong>Connect Ledger</strong>
          <p>
            Physical hardware governance. Review ownership VERIFIED proofs, then open
            the existing Ledger wizard for policy / revoke / unrevoke.
          </p>
          <span className="badge badge-pass">OWNERSHIP VERIFIED</span>
        </button>
        <button
          type="button"
          className="onboard-card"
          onClick={() => (walletConnected ? onNav("overview") : onSignIn())}
        >
          <strong>Connect NEAR Wallet</strong>
          <p>
            Standard testnet wallet. Read-only browsing. Does not claim control of the
            demo policy contract. Owner writes stay Ledger-gated.
          </p>
          <span className="badge badge-warn">NO HARDWARE CLAIM</span>
        </button>
        <button type="button" className="onboard-card" onClick={() => onNav("demo")}>
          <strong>Explore Demo</strong>
          <p>
            No wallet required. Walk real F4/H3 settlements, security rejects, and
            illustrative Predict — recorded verified evidence.
          </p>
          <span className="badge badge-recorded">NO WALLET</span>
        </button>
      </div>
    </section>
  );
}
