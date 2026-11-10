import { useState } from "react";
import {
  ADVERSARIAL_DEMOS,
  GATE_G_ACCOUNTING,
  HARDWARE_OWNERSHIP,
} from "../../data/evidenceSnapshot";
import { SECURITY_DEMOS } from "../../data/receipts";
import { CONFIG } from "../../lib/config";
import { useProductSession } from "../../state/ProductSession";
import { isWithdrawDeliveryEnabled } from "../../adapters/gatei";
import type { NavId } from "./nav";

export function SecurityPage({
  onNav,
  onOpenLedger,
}: {
  onNav: (id: NavId) => void;
  onOpenLedger?: () => void;
}) {
  const { portfolio, authMode, gateI } = useProductSession();
  const [pauseMsg, setPauseMsg] = useState<string | null>(null);
  const withdrawProven = isWithdrawDeliveryEnabled();
  const ownerReady = Boolean(portfolio && authMode && gateI.status === "available");

  const pauseOrRevoke = (kind: "pause" | "revoke") => {
    if (!portfolio || !authMode) {
      setPauseMsg(
        "Personal portfolio management requires an authenticated owner session and is unavailable in public demo mode."
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
      `${kind} is an owner-only mutation. The public BFF does not expose this route.`
    );
  };

  return (
    <div className="page-enter nio-security-page">
      <div className="axis-intro">
        <div>
          <h1>Security</h1>
          <p>
            Current posture, Ledger authority, signing lock, and historical verification —
            without implying clawback of previously signed EVM transactions.
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
              <dt>Auth mode</dt>
              <dd>{authMode ?? "public visitor"}</dd>
            </div>
            <div>
              <dt>Owner portfolio</dt>
              <dd className="mono">{portfolio?.portfolio_id ?? "none"}</dd>
            </div>
          </dl>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Ledger authority</h2>
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
            <h2>NEAR mandate</h2>
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

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Revocation model</h2>
          </div>
          <div className="nio-disclosure">
            <strong>Preserved limitation.</strong> Revocation prevents new authorizations.
            Previously signed EVM transactions may remain executable and cannot be clawed back
            by this UI.
          </div>
        </section>
      </div>

      <section className="axis-panel" style={{ marginTop: 16 }}>
        <div className="axis-panel-heading">
          <h2>Owner-only actions</h2>
          <span className="nio-badge nio-badge-idle">NOT PUBLIC</span>
        </div>
        <p className="axis-supporting">
          Pause, revoke, withdraw/recover, and Ledger wizard require an authenticated owner
          session. They are disabled for public judges.
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
            disabled={!authMode || authMode === "demo"}
            onClick={() => onOpenLedger?.()}
          >
            Ledger wizard
          </button>
        </div>
        {!ownerReady ? (
          <p className="axis-supporting" style={{ marginTop: 10 }}>
            Disabled until an owner portfolio session is connected and the API is reachable.
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
