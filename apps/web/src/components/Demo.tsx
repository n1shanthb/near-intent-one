import { CONFIG } from "../lib/config";
import {
  ADVERSARIAL_DEMOS,
  F4_EXECUTION,
  FROZEN_POLICY,
  GATE_G_ACCOUNTING,
} from "../data/evidenceSnapshot";

const STEPS = [
  {
    n: 1,
    title: "Owner trading policy",
    body: `Frozen epoch ${FROZEN_POLICY.epoch}: max trade ${FROZEN_POLICY.max_trade_value}, slippage ${FROZEN_POLICY.max_slippage_bps} bps, assets allowlisted. Agent cannot change this mid-cycle.`,
  },
  {
    n: 2,
    title: "Agent trades without a private key",
    body: `Agent ${CONFIG.agentAccount} proposes. Policy contract ${CONFIG.policyContract} owns the MPC derivation path and requests Chain Signatures.`,
  },
  {
    n: 3,
    title: "Real unattended F4 cross-chain trade",
    body: `${F4_EXECUTION.amountInDisplay} Sepolia → Tidepool ${F4_EXECUTION.tidepoolStatus}. Operation ${F4_EXECUTION.operationId}. Trust: ${F4_EXECUTION.trustModel}.`,
  },
  {
    n: 4,
    title: "Explorer proofs",
    body: "Open Sepolia deposit and NEAR MPC / settlement links below — recorded verified evidence.",
  },
  {
    n: 5,
    title: "Adversarial reject",
    body: ADVERSARIAL_DEMOS[0].detail,
  },
  {
    n: 6,
    title: "Revocation honesty",
    body: "Revocation prevents NEW authorizations. Previously signed EVM transactions may remain executable (Gate E3).",
  },
  {
    n: 7,
    title: "Ledger ownership",
    body: GATE_G_ACCOUNTING.ledger.note,
  },
];

export function Demo() {
  return (
    <div className="stack">
      <section className="card hero-demo">
        <p className="eyebrow">90-second judge walkthrough</p>
        <h2>Your hardware sets the rules. Your AI trades. NEAR enforces.</h2>
        <p className="lede">
          Demo data below is <strong>RECORDED VERIFIED EVIDENCE</strong> unless you
          switch the sidebar to Live read-only mode.
        </p>
      </section>

      <ol className="demo-steps">
        {STEPS.map((s) => (
          <li key={s.n} className="card">
            <span className="demo-n">{s.n}</span>
            <div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              {s.n === 4 && (
                <div className="proof-links">
                  <a
                    href={`${CONFIG.etherscan}/tx/${F4_EXECUTION.sepoliaTx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Sepolia F4
                  </a>
                  <a
                    href={`${CONFIG.nearblocks}/txns/${F4_EXECUTION.mpcSignTx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    NEAR MPC
                  </a>
                  <a
                    href={`${CONFIG.nearblocks}/txns/${F4_EXECUTION.nearSettlementTxs[0]}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    NEAR settlement
                  </a>
                </div>
              )}
              {s.n === 7 && (
                <p className="warn">
                  Ledger: {GATE_G_ACCOUNTING.ledger.label} — do not demo hardware
                  approval as live until Gate H PASS.
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
