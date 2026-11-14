import { useState } from "react";
import {
  ADVERSARIAL_DEMOS,
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
import {
  IdentityRow,
  MetricCard,
  StatusBadge,
} from "./uiPrimitives";
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
    const stateVersion =
      mandate?.state_version != null && mandate.state_version !== ""
        ? safeText(mandate.state_version)
        : "—";

    return (
      <div className="page-enter nio-page-shell nio-security-page">
        <div className="axis-intro">
          <div>
            <h1>Security</h1>
            <p>
              Live mainnet security posture for{" "}
              <span className="mono">{identities.policy}</span>. Testnet Gate K /
              Gate I service-health is not shown here.
            </p>
          </div>
          <LiveDataChrome />
        </div>

        {mandate?.ok ? (
          <div
            className="axis-stats nio-metric-row"
            style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}
          >
            <MetricCard
              label="Max trade"
              value={usdcLabel(mandate.limits.max_trade_value)}
            />
            <MetricCard
              label="Daily limit"
              value={usdcLabel(mandate.limits.daily_turnover_limit)}
            />
            <MetricCard
              label="Pending cap"
              value={usdcLabel(mandate.limits.max_pending_exposure)}
            />
            <MetricCard
              label="State version"
              value={stateVersion}
              hint={`Epoch ${safeText(mandate.mandate_epoch)}`}
            />
          </div>
        ) : null}

        <div className="nio-security-grid nio-security-grid-2">
          <section className="axis-panel">
            <div className="axis-panel-heading">
              <h2>Current security</h2>
              <StatusBadge tone="success">MAINNET</StatusBadge>
            </div>
            {mandate?.ok ? (
              <>
                <div className="nio-flag-row" style={{ marginBottom: 14 }}>
                  <StatusBadge
                    tone={
                      mandate.autonomous_trading === true
                        ? "success"
                        : mandate.autonomous_trading === false
                          ? "danger"
                          : "idle"
                    }
                  >
                    {`Autonomous ${flagLabel(mandate.autonomous_trading)}`}
                  </StatusBadge>
                  <StatusBadge tone="idle">
                    {`Enforce ${flagLabel(mandate.enforce_autonomous_on_agent)}`}
                  </StatusBadge>
                  <StatusBadge
                    tone={mandate.paused === true ? "warn" : "running"}
                  >
                    {flagLabel(mandate.paused, "PAUSED", "UNPAUSED")}
                  </StatusBadge>
                  <StatusBadge
                    tone={mandate.revoked === true ? "danger" : "success"}
                  >
                    {flagLabel(mandate.revoked, "REVOKED", "NOT_REVOKED")}
                  </StatusBadge>
                </div>
                <div className="nio-identity-stack">
                  <IdentityRow label="Owner" value={safeText(mandate.owner)} />
                  <IdentityRow label="Agent" value={safeText(mandate.agent)} />
                  <IdentityRow label="Policy" value={safeText(mandate.policy)} />
                  <IdentityRow
                    label="Portfolio"
                    value={safeText(mandate.portfolio_id)}
                  />
                  <IdentityRow
                    label="Slippage"
                    value={
                      mandate.limits.max_slippage_bps != null
                        ? `${mandate.limits.max_slippage_bps} bps`
                        : "temporarily unavailable"
                    }
                    mono={false}
                  />
                  <IdentityRow
                    label="Data quality"
                    value={(() => {
                      const raw =
                        mandate.cached_at || mandate.fetched_at || null;
                      const when = raw
                        ? new Date(raw).toLocaleString()
                        : "—";
                      if (
                        mandate.stale ||
                        mandate.data_quality === "LAST_KNOWN_GOOD"
                      ) {
                        return `Last-known-good · ${when}`;
                      }
                      return mandate.fresh ? `Live · ${when}` : `Cached · ${when}`;
                    })()}
                    mono={false}
                  />
                </div>
              </>
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
              <h2>Owner authority</h2>
              <StatusBadge tone="recorded">HISTORICAL EVIDENCE</StatusBadge>
            </div>
            <div className="nio-identity-stack">
              <IdentityRow
                label="Mainnet owner"
                value={safeText(
                  mandate?.owner,
                  identities.owner ?? "nishanthb.near"
                )}
              />
              <IdentityRow
                label="Policy account"
                value={safeText(
                  mandate?.policy,
                  identities.policy ?? "policy.nishanthb.near"
                )}
              />
            </div>
            <div className="nio-disclosure" style={{ marginTop: 14 }}>
              <strong>Historical Ledger evidence only.</strong> Prior testnet Gate G
              Ledger key fingerprints and software FullAccess counts are not live
              mainnet access-key reads. This panel does not invent current key
              inventories. Owner pause/revoke requires a verified personal session.
            </div>
            <p className="axis-supporting" style={{ marginTop: 10 }}>
              Recorded Ledger ceremony note: {HARDWARE_OWNERSHIP.note}
            </p>
          </section>
        </div>

        <section className="axis-panel" style={{ marginTop: 16 }}>
          <div className="axis-panel-heading">
            <h2>Revocation model</h2>
          </div>
          <div className="nio-disclosure" style={{ marginTop: 0 }}>
            <strong>Preserved limitation.</strong> Revocation prevents new
            authorizations. Previously signed EVM transactions may remain
            executable and cannot be clawed back by this UI.
          </div>
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
    <div className="page-enter nio-page-shell nio-security-page">
      <div className="axis-intro">
        <div>
          <h1>Security</h1>
          <p>
            Personal workspace security. Shows your own setup status — not
            Nishanth&apos;s mainnet mandate.
          </p>
        </div>
      </div>

      <div className="nio-security-grid nio-security-grid-2">
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Current posture</h2>
            <StatusBadge tone={personalProvisioned ? "success" : "warn"}>
              {personalProvisioned ? "PROVISIONED" : "NOT PROVISIONED"}
            </StatusBadge>
          </div>
          <div className="nio-identity-stack">
            <IdentityRow
              label="Owner session"
              value={verified ? session?.account_id ?? "—" : "not verified"}
            />
            <IdentityRow label="Wallet mode" value={authMode ?? "unset"} mono={false} />
            <IdentityRow
              label="Personal portfolio"
              value={portfolio?.portfolio_id ?? "none"}
            />
            <IdentityRow
              label="Personal policy"
              value={portfolio?.policy_contract ?? "none"}
            />
            <IdentityRow
              label="API reachability"
              value={
                gateI.status === "available"
                  ? "Connected — service health only"
                  : "Unreachable — service health only"
              }
              mono={false}
            />
          </div>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Owner-only actions</h2>
            <StatusBadge tone="idle">PERSONAL ONLY</StatusBadge>
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
      </div>

      <section className="axis-panel" style={{ marginTop: 16 }}>
        <div className="axis-panel-heading">
          <h2>Historical verification</h2>
          <StatusBadge tone="recorded">TESTNET · ARCHIVAL</StatusBadge>
        </div>
        <ul className="nio-demo-list">
          {[...ADVERSARIAL_DEMOS, ...SECURITY_DEMOS].slice(0, 8).map((d) => (
            <li key={d.id}>
              <div className="nio-demo-list-head">
                <strong>{d.title}</strong>
                <StatusBadge tone="danger">
                  {"result" in d ? String(d.result) : String(d.expect)}
                </StatusBadge>
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
