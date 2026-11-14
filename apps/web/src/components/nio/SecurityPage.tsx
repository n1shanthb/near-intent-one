import { useState } from "react";
import {
  ADVERSARIAL_DEMOS,
  GATE_G_ACCOUNTING,
  HARDWARE_OWNERSHIP,
} from "../../data/evidenceSnapshot";
import { SECURITY_DEMOS } from "../../data/receipts";
import { CONFIG } from "../../lib/config";
import { isWithdrawDeliveryEnabled } from "../../adapters/gatei";
import {
  flagLabel,
  usdcLabel,
  safeText,
} from "../../adapters/mainnetPublic";
import { useOwnerSession } from "../../state/OwnerSession";
import { useProductSession } from "../../state/ProductSession";
import { useWorkspace } from "../../state/WorkspaceContext";
import { LiveDataChrome } from "./WorkspaceSwitcher";
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
  const { isPublic, identities, live, personalProvisioned } = useWorkspace();
  const [pauseMsg, setPauseMsg] = useState<string | null>(null);
  const withdrawProven = isWithdrawDeliveryEnabled();
  const ownerReady = verified && Boolean(session?.account_id);
  const mandate = isPublic ? live.mandate : null;

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

  if (isPublic) {
    return (
      <div className="page-enter nio-security-page">
        <div className="axis-intro">
          <div>
            <h1>Security</h1>
            <p>
              Live mainnet security posture for{" "}
              <span className="mono">{identities.policy}</span>. Gate K / testnet
              service-health is not shown here.
            </p>
          </div>
          <LiveDataChrome />
        </div>

        <div className="nio-security-grid">
          <section className="axis-panel">
            <div className="axis-panel-heading">
              <h2>Current security</h2>
              <span className="nio-badge nio-badge-success">MAINNET</span>
            </div>
            {mandate?.ok ? (
              <dl className="nio-kv nio-kv-compact">
                <div>
                  <dt>Owner</dt>
                  <dd className="mono">{safeText(mandate.owner)}</dd>
                </div>
                <div>
                  <dt>Agent</dt>
                  <dd className="mono">{safeText(mandate.agent)}</dd>
                </div>
                <div>
                  <dt>Policy</dt>
                  <dd className="mono">{safeText(mandate.policy)}</dd>
                </div>
                <div>
                  <dt>Portfolio</dt>
                  <dd className="mono">{safeText(mandate.portfolio_id)}</dd>
                </div>
                <div>
                  <dt>Autonomous trading</dt>
                  <dd>
                    <span
                      className={`nio-badge ${
                        mandate.autonomous_trading === true
                          ? "nio-badge-success"
                          : mandate.autonomous_trading === false
                            ? "nio-badge-danger"
                            : "nio-badge-idle"
                      }`}
                    >
                      {flagLabel(mandate.autonomous_trading)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Enforce on agent</dt>
                  <dd>
                    <span className="nio-badge nio-badge-idle">
                      {flagLabel(mandate.enforce_autonomous_on_agent)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Paused</dt>
                  <dd>{flagLabel(mandate.paused, "PAUSED", "UNPAUSED")}</dd>
                </div>
                <div>
                  <dt>Revoked</dt>
                  <dd>{flagLabel(mandate.revoked, "REVOKED", "NOT_REVOKED")}</dd>
                </div>
                <div>
                  <dt>Max trade / daily / pending</dt>
                  <dd>
                    {usdcLabel(mandate.limits.max_trade_value)} ·{" "}
                    {usdcLabel(mandate.limits.daily_turnover_limit)} ·{" "}
                    {usdcLabel(mandate.limits.max_pending_exposure)}
                  </dd>
                </div>
                <div>
                  <dt>Slippage</dt>
                  <dd>
                    {mandate.limits.max_slippage_bps != null
                      ? `${mandate.limits.max_slippage_bps} bps`
                      : "temporarily unavailable"}
                  </dd>
                </div>
                <div>
                  <dt>State version / epoch</dt>
                  <dd className="mono">
                    {safeText(mandate.state_version)} · epoch{" "}
                    {safeText(mandate.mandate_epoch)}
                  </dd>
                </div>
                <div>
                  <dt>Data quality</dt>
                  <dd>
                    {mandate.stale || mandate.data_quality === "LAST_KNOWN_GOOD"
                      ? `Last-known-good · ${mandate.cached_at || mandate.fetched_at}`
                      : mandate.fresh
                        ? `Live · ${mandate.fetched_at}`
                        : `Cached · ${mandate.fetched_at}`}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="axis-supporting">
                {live.status === "loading"
                  ? "Loading mainnet security posture…"
                  : `Temporarily unavailable${live.error ? `: ${live.error}` : "."}`}
              </p>
            )}
          </section>

          <section className="axis-panel">
            <div className="axis-panel-heading">
              <h2>Ledger owner authority</h2>
              <span className="nio-badge nio-badge-recorded">RECORDED</span>
            </div>
            <dl className="nio-kv nio-kv-compact">
              <div>
                <dt>Recorded owner</dt>
                <dd className="mono">{HARDWARE_OWNERSHIP.ownerAccount}</dd>
              </div>
              <div>
                <dt>Ledger key</dt>
                <dd className="mono">
                  {HARDWARE_OWNERSHIP.ledgerPublicKey.slice(0, 28)}…
                </dd>
              </div>
              <div>
                <dt>Software FA left</dt>
                <dd>{String(GATE_G_ACCOUNTING.ledger.softwareFullAccessRemaining)}</dd>
              </div>
            </dl>
            <p className="axis-supporting">{HARDWARE_OWNERSHIP.note}</p>
          </section>
        </div>

        <section className="axis-panel" style={{ marginTop: 16 }}>
          <div className="axis-panel-heading">
            <h2>Revocation model</h2>
          </div>
          <div className="nio-disclosure">
            <strong>Preserved limitation.</strong> Revocation prevents new
            authorizations. Previously signed EVM transactions may remain
            executable and cannot be clawed back by this UI.
          </div>
        </section>

        <section className="axis-panel" style={{ marginTop: 16 }}>
          <div className="axis-panel-heading">
            <h2>Public workspace note</h2>
          </div>
          <p className="axis-supporting">
            Pause / revoke / withdraw require a verified owner session in the
            personal workspace. This page never conflates Gate I testnet
            service-health with mainnet policy state.
          </p>
          <div className="axis-actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="axis-button secondary"
              onClick={() => onNav("mandate")}
            >
              Open mandate
            </button>
            <button
              type="button"
              className="axis-button secondary"
              onClick={() => onNav("verify")}
            >
              Proof &amp; Verify
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page-enter nio-security-page">
      <div className="axis-intro">
        <div>
          <h1>Security</h1>
          <p>
            Personal workspace security. Shows your own setup status — not
            Nishanth&apos;s mainnet mandate.
          </p>
        </div>
      </div>

      <div className="nio-security-grid">
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Current posture</h2>
            <span
              className={`nio-badge ${
                personalProvisioned ? "nio-badge-success" : "nio-badge-warn"
              }`}
            >
              {personalProvisioned ? "PROVISIONED" : "NOT PROVISIONED"}
            </span>
          </div>
          <dl className="nio-kv nio-kv-compact">
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
              <dd>{authMode ?? "unset"}</dd>
            </div>
            <div>
              <dt>Personal portfolio</dt>
              <dd className="mono">{portfolio?.portfolio_id ?? "none"}</dd>
            </div>
            <div>
              <dt>Personal policy</dt>
              <dd className="mono">{portfolio?.policy_contract ?? "none"}</dd>
            </div>
            <div>
              <dt>API reachability</dt>
              <dd>
                {gateI.status === "available" ? "Connected" : "Unreachable"} —{" "}
                service health only, not mainnet policy state
              </dd>
            </div>
          </dl>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Ledger authority (recorded)</h2>
          </div>
          <dl className="nio-kv nio-kv-compact">
            <div>
              <dt>Recorded owner</dt>
              <dd className="mono">{HARDWARE_OWNERSHIP.ownerAccount}</dd>
            </div>
            <div>
              <dt>Ledger key</dt>
              <dd className="mono">
                {HARDWARE_OWNERSHIP.ledgerPublicKey.slice(0, 28)}…
              </dd>
            </div>
            <div>
              <dt>Software FA left</dt>
              <dd>{String(GATE_G_ACCOUNTING.ledger.softwareFullAccessRemaining)}</dd>
            </div>
          </dl>
          <p className="axis-supporting">{HARDWARE_OWNERSHIP.note}</p>
        </section>
      </div>

      <section className="axis-panel" style={{ marginTop: 16 }}>
        <div className="axis-panel-heading">
          <h2>Owner-only actions</h2>
          <span className="nio-badge nio-badge-idle">PERSONAL ONLY</span>
        </div>
        <p className="axis-supporting">
          Pause, revoke, withdraw/recover, and Ledger wizard require a verified
          owner session.
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
        {pauseMsg ? (
          <p className="nio-disclosure" style={{ marginTop: 12 }}>
            {pauseMsg}
          </p>
        ) : null}
      </section>

      <section className="axis-panel" style={{ marginTop: 16 }}>
        <div className="axis-panel-heading">
          <h2>Historical verification</h2>
          <span className="nio-badge nio-badge-recorded">TESTNET · ARCHIVAL</span>
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
              {typeof d.id === "string" && d.id.includes("revoke") ? (
                <a
                  href={`${CONFIG.nearblocks}/txns/${HARDWARE_OWNERSHIP.revokeTx}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Nearblocks revoke proof
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
