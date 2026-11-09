import { CONFIG } from "../lib/config";
import {
  ADVERSARIAL_DEMOS,
  F4_EXECUTION,
  FROZEN_POLICY,
  H3_DECISION,
  H3_EXECUTION,
  HARDWARE_OWNERSHIP,
  MANDATE_AFTER_H1,
} from "../data/evidenceSnapshot";
import { Onboarding } from "./Onboarding";
import type { NavId } from "./Shell";

export function Demo({
  onNav,
  onSignIn,
  walletConnected,
}: {
  onNav: (id: NavId) => void;
  onSignIn: () => void;
  walletConnected: boolean;
}) {
  return (
    <div className="stack">
      <section className="card hero-demo">
        <p className="eyebrow">90-second judge walkthrough</p>
        <h2>Your hardware sets the rules. Your AI trades. NEAR enforces.</h2>
        <p className="lede">
          Everything below is <strong>RECORDED VERIFIED EVIDENCE</strong> unless you
          switch to Live reads. Mandate is currently{" "}
          <strong>revoked @ epoch {MANDATE_AFTER_H1.mandate_epoch}</strong> after the
          hardware revoke proof — we do not auto-unrevoke.
        </p>
      </section>

      <Onboarding onNav={onNav} onSignIn={onSignIn} walletConnected={walletConnected} />

      <ol className="demo-steps">
        <li className="card">
          <span className="demo-n">1</span>
          <div>
            <h3>Owner policy & restrictions</h3>
            <p>
              Frozen limits: max trade {FROZEN_POLICY.max_trade_value}, slippage{" "}
              {FROZEN_POLICY.max_slippage_bps} bps, allowlisted assets. Owner writes
              require Ledger.
            </p>
          </div>
        </li>
        <li className="card">
          <span className="demo-n">2</span>
          <div>
            <h3>Agent has no private key</h3>
            <p>
              Agent proposes; policy contract requests MPC. Reconciler is a separate
              account after H2.
            </p>
          </div>
        </li>
        <li className="card">
          <span className="demo-n">3</span>
          <div>
            <h3>Real H3 strategy TRADE</h3>
            <p>
              {H3_DECISION.rationale} Amount {H3_DECISION.amountInDisplay}. Not an
              LLM trade.
            </p>
            <div className="proof-links">
              <a
                href={`${CONFIG.etherscan}/tx/${H3_EXECUTION.sepoliaTx}`}
                target="_blank"
                rel="noreferrer"
              >
                Sepolia H3
              </a>
              <a
                href={`${CONFIG.nearblocks}/txns/${H3_EXECUTION.mpcSignTx}`}
                target="_blank"
                rel="noreferrer"
              >
                NEAR MPC
              </a>
              <a
                href={`${CONFIG.nearblocks}/txns/${H3_EXECUTION.reconcileTx}`}
                target="_blank"
                rel="noreferrer"
              >
                Reconcile
              </a>
            </div>
          </div>
        </li>
        <li className="card">
          <span className="demo-n">4</span>
          <div>
            <h3>Prior F4 unattended settle</h3>
            <p>
              {F4_EXECUTION.amountInDisplay} · Tidepool {F4_EXECUTION.tidepoolStatus}
            </p>
            <div className="proof-links">
              <a
                href={`${CONFIG.etherscan}/tx/${F4_EXECUTION.sepoliaTx}`}
                target="_blank"
                rel="noreferrer"
              >
                Sepolia F4
              </a>
              <a
                href={`${CONFIG.nearblocks}/txns/${F4_EXECUTION.nearSettlementTxs[0]}`}
                target="_blank"
                rel="noreferrer"
              >
                NEAR F4
              </a>
            </div>
          </div>
        </li>
        <li className="card">
          <span className="demo-n">5</span>
          <div>
            <h3>Adversarial reject</h3>
            <p>{ADVERSARIAL_DEMOS[0].detail}</p>
          </div>
        </li>
        <li className="card">
          <span className="demo-n">6</span>
          <div>
            <h3>Revocation honesty</h3>
            <p>
              Revocation stops NEW signing. Previously signed EVM txs may remain
              executable (E3). Hardware revoke tx{" "}
              <a
                href={`${CONFIG.nearblocks}/txns/${HARDWARE_OWNERSHIP.revokeTx}`}
                target="_blank"
                rel="noreferrer"
              >
                EndhGnPp…
              </a>
            </p>
          </div>
        </li>
        <li className="card">
          <span className="demo-n">7</span>
          <div>
            <h3>Ledger ownership VERIFIED</h3>
            <p>
              set_policy{" "}
              <a
                href={`${CONFIG.nearblocks}/txns/${HARDWARE_OWNERSHIP.setPolicyTx}`}
                target="_blank"
                rel="noreferrer"
              >
                7SrK8M8e…
              </a>
              · software keys removed · Ledger-only FullAccess on owner + policy.
              Device may be DISCONNECTED now — ownership remains verified.
            </p>
            <button type="button" className="ghost" onClick={() => onNav("ledger")}>
              Open Ledger setup
            </button>
          </div>
        </li>
      </ol>
    </div>
  );
}
