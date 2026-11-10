import { useState } from "react";
import {
  ADVERSARIAL_DEMOS,
  GATE_G_ACCOUNTING,
  HARDWARE_OWNERSHIP,
} from "../data/evidenceSnapshot";
import { SECURITY_DEMOS } from "../data/receipts";
import { CONFIG } from "../lib/config";
import { useProductSession } from "../state/ProductSession";
import { GateIBanner } from "./GateIBanner";
import { isWithdrawDeliveryEnabled } from "../adapters/gatei";

export function Security({
  onOpenLedger,
  onOpenFunds,
}: {
  onOpenLedger?: () => void;
  onOpenFunds?: () => void;
}) {
  const { portfolio, authMode, gateI } = useProductSession();
  const [pauseMsg, setPauseMsg] = useState<string | null>(null);
  const withdrawProven = isWithdrawDeliveryEnabled();

  const pauseOrRevoke = (kind: "pause" | "revoke") => {
    if (!portfolio) {
      setPauseMsg("No personal portfolio — open Welcome → Portfolio first.");
      return;
    }
    if (gateI.status !== "available") {
      setPauseMsg(
        `Live API unreachable — ${kind} trading is blocked (no fake success).`
      );
      return;
    }
    setPauseMsg(
      `${kind} is owner-only. The public demo does not expose this mutation route. Auth mode: ${authMode ?? "unset"}.`
    );
  };

  return (
    <div className="stack">
      <section className="card alert">
        <h3>Revocation model (Gate E3 — preserved)</h3>
        <p>
          <strong>
            Revocation prevents new authorizations. Previously signed EVM
            transactions may remain executable.
          </strong>
        </p>
        <p className="muted">
          Hardware revoke proof:{" "}
          <a
            href={`${CONFIG.nearblocks}/txns/${HARDWARE_OWNERSHIP.revokeTx}`}
            target="_blank"
            rel="noreferrer"
          >
            {HARDWARE_OWNERSHIP.revokeTx.slice(0, 14)}…
          </a>{" "}
          → revoked=true epoch {HARDWARE_OWNERSHIP.revokeVerified.mandate_epoch}.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Your portfolio controls</h3>
          <span className="badge badge-warn">TESTNET</span>
        </div>
        <GateIBanner action="Pause / revoke" />
        <dl className="kv dense">
          <dt>Current owner</dt>
          <dd className="mono">
            {portfolio?.owner_account ?? "— (no personal portfolio)"}
          </dd>
          <dt>Upgrade / policy authority</dt>
          <dd className="mono">
            {portfolio?.policy_contract ?? "—"}
          </dd>
          <dt>Pending exposure</dt>
          <dd>
            {gateI.status === "available" && portfolio
              ? "Request via Gate I balances / agent (live when API online)"
              : "Unavailable until Gate I reports verified reconciliation"}
          </dd>
          <dt>Reconciliation</dt>
          <dd>
            {portfolio?.reconciler_account
              ? `Reconciler ${portfolio.reconciler_account}`
              : "Not assigned — Gate I deploy pending"}
          </dd>
        </dl>
        <div className="row gap wrap">
          <button type="button" onClick={() => pauseOrRevoke("pause")}>
            Pause trading
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => pauseOrRevoke("revoke")}
          >
            Revoke mandate
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!withdrawProven}
            onClick={() => onOpenFunds?.()}
          >
            {withdrawProven
              ? "Withdraw / recovery"
              : "Withdraw blocked until proven"}
          </button>
          {authMode === "ledger" || !authMode ? (
            <button type="button" className="ghost" onClick={() => onOpenLedger?.()}>
              Ledger wizard
            </button>
          ) : null}
        </div>
        {pauseMsg ? <p className="warn">{pauseMsg}</p> : null}
        <p className="muted small">
          Recovery: use Deposit / Withdraw when Gate I proves the path. Ordinary
          wallets do not receive Ledger approval chrome.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Demo Ledger-only authority (recorded)</h3>
          <span className="badge badge-pass">{GATE_G_ACCOUNTING.ledger.label}</span>
        </div>
        <dl className="kv">
          <dt>Ledger key</dt>
          <dd className="mono">{HARDWARE_OWNERSHIP.ledgerPublicKey}</dd>
          <dt>set_policy</dt>
          <dd className="mono">
            <a
              href={`${CONFIG.nearblocks}/txns/${HARDWARE_OWNERSHIP.setPolicyTx}`}
              target="_blank"
              rel="noreferrer"
            >
              {HARDWARE_OWNERSHIP.setPolicyTx}
            </a>
          </dd>
          <dt>Software FA left</dt>
          <dd>{GATE_G_ACCOUNTING.ledger.softwareFullAccessRemaining}</dd>
        </dl>
        <p className="muted small">{HARDWARE_OWNERSHIP.note}</p>
      </section>

      <section className="card">
        <h3>Separate reconciler (H2)</h3>
        <p>
          Reconciler <span className="mono">{GATE_G_ACCOUNTING.reconciler}</span> is
          not the trading agent. Contract stores evidence_hash with
          verified_onchain=false.
        </p>
      </section>

      <section className="card">
        <h3>Rejection gallery</h3>
        <ul className="demo-list">
          {[...ADVERSARIAL_DEMOS, ...SECURITY_DEMOS].map((d) => (
            <li key={d.id}>
              <div className="row between">
                <strong>{d.title}</strong>
                <span className="badge badge-danger">
                  {"result" in d ? d.result : d.expect}
                </span>
              </div>
              <p className="muted">{"detail" in d ? d.detail : d.how}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
