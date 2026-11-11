import { useState } from "react";
import {
  ADVERSARIAL_DEMOS,
  GATE_G_ACCOUNTING,
  HARDWARE_OWNERSHIP,
} from "../../data/evidenceSnapshot";
import { SECURITY_DEMOS } from "../../data/receipts";
import { MAINNET_EVIDENCE } from "../../data/mainnetEvidence";
import { CONFIG } from "../../lib/config";
import { isWithdrawDeliveryEnabled } from "../../adapters/gatei";
import { useOwnerSession } from "../../state/OwnerSession";
import { useProductSession } from "../../state/ProductSession";
import type { NavId } from "./nav";

export function SecurityPage({
  onNav,
  onOpenLedger,
}: {
  onNav: (id: NavId) => void;
  onOpenLedger?: () => void;
}) {
  const { portfolio, authMode, gateI } = useProductSession();
  const { verified, session } = useOwnerSession();
  const [pauseMsg, setPauseMsg] = useState<string | null>(null);
  const withdrawProven = isWithdrawDeliveryEnabled();
  const ownerReady = verified && Boolean(session?.account_id);

  const pauseOrRevoke = (kind: "pause" | "revoke") => {
    if (!verified || !session?.account_id) {
      setPauseMsg(
        "Personal portfolio management requires a verified owner session and is unavailable in public demo mode."
      );
      return;
    }
    if (gateI.status !== "available") {
      setPauseMsg(
        `Live API unreachable — ${kind} remains blocked (no fake success).`
      );
      return;
    }
    setPauseMsg(
      `${kind} is an owner-only mutation. The public BFF does not expose this route. Use the Ledger wizard after a provisioned personal policy account exists.`
    );
  };

  return (
    <div className="page-enter nio-security-page">
      <div className="axis-intro">
        <div>
          <h1>Security</h1>
          <p>
            Current posture, Ledger authority, signing lock, and recovery
            limitations — without implying clawback of previously signed EVM
            transactions or always-independent recovery.
          </p>
        </div>
      </div>

      <div className="nio-security-grid">
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Current posture</h2>
            <span className={`nio-badge ${gateI.status === "available" ? "nio-badge-success" : "nio-badge-warn"}`}>
              {gateI.status === "available" ? "API connected" : "Recorded / unreachable"}
            </span>
          </div>
          <dl className="nio-kv">
            <div>
              <dt>Signing / execution</dt>
              <dd>
                <span className="nio-badge nio-badge-danger">LOCKED</span> Gate K allow-sign OFF
              </dd>
            </div>
            <div>
              <dt>Autonomous mode</dt>
              <dd>
                <span className="nio-badge nio-badge-danger">OFF</span>
              </dd>
            </div>
            <div>
              <dt>Owner session</dt>
              <dd>
                {verified ? (
                  <span className="mono">{session?.account_id}</span>
                ) : (
                  "not verified"
                )}
              </dd>
            </div>
            <div>
              <dt>Product wallet mode</dt>
              <dd>{authMode ?? "public visitor"} (separate from Ledger owner path)</dd>
            </div>
            <div>
              <dt>Bound portfolio (product)</dt>
              <dd className="mono">{portfolio?.portfolio_id ?? "none"}</dd>
            </div>
          </dl>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Recovery surface</h2>
            <span className="nio-badge nio-badge-warn">LIMITATIONS</span>
          </div>
          <dl className="nio-kv">
            <div>
              <dt>Owner account</dt>
              <dd className="mono">
                {session?.account_id ?? HARDWARE_OWNERSHIP.ownerAccount}
              </dd>
            </div>
            <div>
              <dt>Contract account</dt>
              <dd className="mono">
                {MAINNET_EVIDENCE.contract.account_id ??
                  HARDWARE_OWNERSHIP.policyAccount}
              </dd>
            </div>
            <div>
              <dt>Supported networks</dt>
              <dd>NEAR testnet demo · mainnet deposits blocked this sprint</dd>
            </div>
            <div>
              <dt>MPC addresses</dt>
              <dd>
                Shown only after deposit readiness — currently withheld as fundable
              </dd>
            </div>
            <div>
              <dt>Confirmed assets</dt>
              <dd>Live personal balances require owner session + provisioned portfolio</dd>
            </div>
            <div>
              <dt>Pending settlements</dt>
              <dd>No durable public settlement journal exposed in this UI</dd>
            </div>
            <div>
              <dt>Revoke / pause</dt>
              <dd>
                {ownerReady
                  ? "Owner can attempt via Ledger wizard — public BFF blocked"
                  : "Requires verified owner session"}
              </dd>
            </div>
            <div>
              <dt>Exported-signature limitation</dt>
              <dd>
                Revoke blocks new authorizations; already-exported ECDSA may still
                execute
              </dd>
            </div>
            <div>
              <dt>Independent recovery</dt>
              <dd>
                Not always available in-product. FullAccess + known addresses may
                allow direct recovery outside this UI — not demonstrated as a
                complete product path.
              </dd>
            </div>
          </dl>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Ledger authority (recorded)</h2>
          </div>
          <dl className="nio-kv">
            <div>
              <dt>Recorded owner</dt>
              <dd className="mono">{HARDWARE_OWNERSHIP.ownerAccount}</dd>
            </div>
            <div>
              <dt>Ledger key</dt>
              <dd className="mono">{HARDWARE_OWNERSHIP.ledgerPublicKey.slice(0, 28)}…</dd>
            </div>
            <div>
              <dt>Software FA left</dt>
              <dd>{String(GATE_G_ACCOUNTING.ledger.softwareFullAccessRemaining)}</dd>
            </div>
          </dl>
          <p className="axis-supporting">{HARDWARE_OWNERSHIP.note}</p>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>NEAR mandate (recorded testnet)</h2>
          </div>
          <dl className="nio-kv">
            <div>
              <dt>Policy account</dt>
              <dd className="mono">{HARDWARE_OWNERSHIP.policyAccount}</dd>
            </div>
            <div>
              <dt>Revoke proof</dt>
              <dd>
                <a
                  href={`${CONFIG.nearblocks}/txns/${HARDWARE_OWNERSHIP.revokeTx}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {HARDWARE_OWNERSHIP.revokeTx.slice(0, 14)}…
                </a>
              </dd>
            </div>
            <div>
              <dt>Epoch after revoke</dt>
              <dd className="mono">{HARDWARE_OWNERSHIP.revokeVerified.mandate_epoch}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="axis-panel" style={{ marginTop: 16 }}>
        <div className="axis-panel-heading">
          <h2>Revocation model</h2>
        </div>
        <div className="nio-disclosure">
          <strong>Preserved limitation.</strong> Revocation prevents new authorizations.
          Previously signed EVM transactions may remain executable and cannot be clawed back
          by this UI.
        </div>
      </section>

      <section className="axis-panel" style={{ marginTop: 16 }}>
        <div className="axis-panel-heading">
          <h2>Owner-only actions</h2>
          <span className="nio-badge nio-badge-idle">NOT PUBLIC</span>
        </div>
        <p className="axis-supporting">
          Pause, revoke, withdraw/recover, and Ledger wizard require a verified owner
          session. Ordinary wallet connect is a separate path and does not unlock these.
        </p>
        <div className="axis-actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="axis-button secondary"
            disabled={!ownerReady}
            onClick={() => pauseOrRevoke("pause")}
          >
            Pause trading
          </button>
          <button
            type="button"
            className="axis-button danger"
            disabled={!ownerReady}
            onClick={() => pauseOrRevoke("revoke")}
          >
            Revoke mandate
          </button>
          <button
            type="button"
            className="axis-button secondary"
            disabled={!ownerReady || !withdrawProven}
            onClick={() => onNav("funds")}
          >
            {withdrawProven ? "Withdraw / recovery" : "Withdraw locked"}
          </button>
          <button
            type="button"
            className="axis-button secondary"
            disabled={!ownerReady}
            onClick={() => onOpenLedger?.()}
          >
            Ledger wizard
          </button>
          {!verified ? (
            <button
              type="button"
              className="axis-button"
              onClick={() => onNav("owner")}
            >
              Verify ownership
            </button>
          ) : null}
        </div>
        {!ownerReady ? (
          <p className="axis-supporting" style={{ marginTop: 10 }}>
            Disabled until a verified owner session exists. Product wallet auth alone
            is insufficient.
          </p>
        ) : null}
        {pauseMsg ? <p className="nio-disclosure" style={{ marginTop: 12 }}>{pauseMsg}</p> : null}
      </section>

      <section className="axis-panel" style={{ marginTop: 16 }}>
        <div className="axis-panel-heading">
          <h2>Historical verification</h2>
        </div>
        <ul className="nio-demo-list">
          {[...ADVERSARIAL_DEMOS, ...SECURITY_DEMOS].slice(0, 8).map((d) => (
            <li key={d.id}>
              <div className="nio-demo-list-head">
                <strong>{d.title}</strong>
                <span className="nio-badge nio-badge-danger">
                  {"result" in d ? String(d.result) : String(d.expect)}
                </span>
              </div>
              <p className="axis-supporting">
                {"detail" in d ? String(d.detail) : String(d.how)}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
