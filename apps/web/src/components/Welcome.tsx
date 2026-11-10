import { useNearWallet } from "near-connect-hooks";
import { GateIBanner } from "./GateIBanner";
import { useProductSession } from "../state/ProductSession";
import type { NavId } from "./Shell";

const TESTED_WALLETS = ["MyNearWallet (testnet via near-connect-hooks)"] as const;

export function Welcome({
  onNav,
}: {
  onNav: (id: NavId) => void;
}) {
  const { signedAccountId, signIn, signOut, loading } = useNearWallet();
  const { authMode, setAuthMode, portfolio, gateI } = useProductSession();

  return (
    <div className="stack">
      <section className="card hero-demo">
        <p className="eyebrow">Testnet only · personal funds path</p>
        <h2>Connect, fund your own portfolio, set policy, trade, withdraw.</h2>
        <p className="lede">
          This is the user product. The judge demo (recorded F4/H3) stays under{" "}
          <button type="button" className="linkish" onClick={() => onNav("demo")}>
            Judge demo
          </button>
          . Personal deposits never use the shared demo custody account.
        </p>
      </section>

      <GateIBanner action="Creating a personal portfolio" />

      <section className="card">
        <div className="card-head">
          <h3>How you authorize</h3>
          <span className="badge badge-warn">TESTNET</span>
        </div>
        <div className="onboard-grid">
          <button
            type="button"
            className="onboard-card"
            onClick={() => {
              setAuthMode("ledger");
              onNav("ledger");
            }}
          >
            <strong>Connect Ledger</strong>
            <p>
              Hardware FullAccess for owner writes (set_policy, revoke, pause). Device
              must confirm on-screen. Not the same as a browser wallet click.
            </p>
            <span className="badge badge-pass">HARDWARE AUTHORIZATION</span>
          </button>

          <button
            type="button"
            className="onboard-card"
            disabled={loading}
            onClick={() => {
              setAuthMode("near_wallet");
              if (signedAccountId) onNav("portfolio");
              else void signIn();
            }}
          >
            <strong>Connect NEAR wallet</strong>
            <p>
              Ordinary wallet signing for account creation and (when Gate I proves it)
              deposits/withdrawals you own. Does <em>not</em> show Ledger prompts.
            </p>
            <span className="badge badge-warn">NO HARDWARE CLAIM</span>
          </button>

          <button
            type="button"
            className="onboard-card"
            onClick={() => {
              setAuthMode("demo");
              onNav("demo");
            }}
          >
            <strong>Explore demo without funds</strong>
            <p>
              Recorded verified evidence only. No personal portfolio, no deposit
              addresses, no fabricated balances.
            </p>
            <span className="badge badge-recorded">NO FUNDS</span>
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Session</h3>
        <dl className="kv dense">
          <dt>Auth mode</dt>
          <dd>{authMode ?? "not chosen"}</dd>
          <dt>Connected account</dt>
          <dd className="mono">
            {signedAccountId ?? "disconnected"}
            {signedAccountId ? (
              <>
                {" "}
                <button type="button" className="ghost tiny" onClick={() => void signOut()}>
                  Disconnect
                </button>
              </>
            ) : null}
          </dd>
          <dt>Personal portfolio</dt>
          <dd className="mono">
            {portfolio?.portfolio_id ?? "none yet"}
            {portfolio ? (
              <>
                {" "}
                <button type="button" className="ghost tiny" onClick={() => onNav("portfolio")}>
                  Open
                </button>
              </>
            ) : null}
          </dd>
          <dt>Gate I</dt>
          <dd>{gateI.status}</dd>
        </dl>
        {signedAccountId && !portfolio ? (
          <button
            type="button"
            disabled={gateI.status !== "available"}
            onClick={() => onNav("portfolio")}
          >
            Continue to portfolio onboarding
          </button>
        ) : null}
      </section>

      <section className="card">
        <h3>Supported wallets (tested)</h3>
        <p className="muted">
          We only list what this build exercises. Broad “any NEAR wallet” claims are
          not advertised.
        </p>
        <ul className="chip-row">
          {TESTED_WALLETS.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <p className="muted small">
          Hardware path: Ledger via the existing setup wizard. Ordinary wallet path:
          near-connect-hooks testnet sign-in. Historic Ledger demo ownership (
          <span className="mono">nio-c-*</span>) is separate from Gate I provisioned
          owners.
        </p>
      </section>

      <section className="card">
        <h3>Gate I provisioned owners (A/B isolation)</h3>
        <p className="muted">
          Self-serve factory is blocked on this host. Connect one of these testnet
          owners after <span className="mono">gate-i-provision</span>:
        </p>
        <ul className="demo-list">
          <li>
            <strong>User A</strong>{" "}
            <span className="mono">nio-i-a4e7-a-owner.testnet</span> → portfolio{" "}
            <span className="mono">i-a-a4e7</span> · MPC{" "}
            <span className="mono">0x30af279b…e752</span>
          </li>
          <li>
            <strong>User B</strong>{" "}
            <span className="mono">owner.nio-i-a4e7-agent.testnet</span> → portfolio{" "}
            <span className="mono">i-b-a4e7</span> · MPC{" "}
            <span className="mono">0xe37d726f…4f63</span>
          </li>
        </ul>
        <p className="muted small">
          Hosted API:{" "}
          <span className="mono">http://129.225.72.169:8787/v1</span> (OCI). Local
          fallback <span className="mono">http://127.0.0.1:8787/v1</span>. Withdraw
          proven (<span className="mono">VITE_GATE_I_WITHDRAW_PROVEN=true</span>) after
          GATE_I.md B2 PASS.
        </p>
      </section>
    </div>
  );
}
