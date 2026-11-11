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
      <h2>Entry paths. No false hardware or deposit claims.</h2>
      <div className="onboard-grid">
        <button type="button" className="onboard-card" onClick={() => onNav("ledger")}>
          <strong>Connect Ledger</strong>
          <p>
            Physical hardware ownership path. NEP-413 verifies the owner session —
            it does not authorize trading by itself.
          </p>
          <span className="badge badge-warn">OWNERSHIP PROOF</span>
        </button>
        <button
          type="button"
          className="onboard-card"
          onClick={() =>
            walletConnected ? onNav("portfolio") : onSignIn()
          }
        >
          <strong>Connect NEAR Wallet</strong>
          <p>
            Separate software-wallet path. Not equivalent to Ledger owner auth.
            Does not unlock personal agent start/stop or mainnet deposits.
          </p>
          <span className="badge badge-warn">NO HARDWARE CLAIM</span>
        </button>
        <button type="button" className="onboard-card" onClick={() => onNav("welcome")}>
          <strong>Open user product</strong>
          <p>
            Honest journey: connect → verify → portfolio → mandate → contract →
            deposit → agent → trade → withdraw. Steps stay BLOCKED until real.
          </p>
          <span className="badge badge-pass">PRODUCT</span>
        </button>
        <button type="button" className="onboard-card" onClick={() => onNav("demo")}>
          <strong>Explore Demo</strong>
          <p>
            No wallet required. Walk recorded F4/H3 settlements and Live AI
            dry-run. Demo portfolio is never your personal custody.
          </p>
          <span className="badge badge-recorded">NO WALLET</span>
        </button>
      </div>
      <p className="warn" style={{ marginTop: 12 }}>
        Mainnet deposits are not enabled. Do not send funds.
      </p>
    </section>
  );
}
