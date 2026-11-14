import {
  usdcLabel,
  chainBadge,
  safeText,
  safeNumber,
  flagLabel,
} from "../../adapters/mainnetPublic";
import {
  formatLastUpdated,
  useWorkspace,
} from "../../state/WorkspaceContext";
import { LiveDataChrome } from "./WorkspaceSwitcher";

/**
 * Live on-chain mandate panel (read-only). Uses workspace live feeds in
 * Nishanth public mode. Personal mode shows honest empty/setup state.
 */
export function AutonomousMandatePreview() {
  const { isPublic, live, identities, personalProvisioned } = useWorkspace();
  const mandate = isPublic ? live.mandate : null;
  const loading = isPublic && live.status === "loading" && !mandate;
  const error = isPublic ? live.error : null;
  const quality = mandate?.data_quality || null;
  const isLastGood = quality === "LAST_KNOWN_GOOD" || Boolean(mandate?.stale);

  const expiry =
    mandate?.expiry?.expires_in_ms != null
      ? `${Math.floor(mandate.expiry.expires_in_ms / 3600_000)}h remaining`
      : "—";

  if (!isPublic) {
    return (
      <section className="axis-panel" style={{ marginTop: "1.5rem" }}>
        <div className="axis-panel-heading">
          <h2>Personal mandate</h2>
          <span className="nio-badge nio-badge-warn">
            {personalProvisioned ? "OWNER BOUND" : "NOT PROVISIONED"}
          </span>
        </div>
        <p className="axis-supporting">
          {personalProvisioned
            ? `Bound portfolio ${identities.portfolio_id}. Live mandate views appear when your policy contract is provisioned.`
            : "No personal policy provisioned. This panel does not show Nishanth's mainnet mandate."}
        </p>
      </section>
    );
  }

  const freshnessLabel = !mandate
    ? null
    : isLastGood
      ? `Last-known-good · ${mandate.cached_at || mandate.fetched_at || "dated"}`
      : mandate.fresh
        ? `Fresh · ${mandate.fetched_at || formatLastUpdated(live.lastUpdated)}`
        : `Cached · ${mandate.fetched_at || formatLastUpdated(live.lastUpdated)}`;

  return (
    <section className="axis-panel" style={{ marginTop: "1.5rem" }}>
      <div className="axis-panel-heading">
        <h2>Live on-chain mandate</h2>
        <span className="nio-badge nio-badge-success">MAINNET</span>
      </div>
      <p className="axis-supporting">
        Sourced from <code className="mono">{identities.policy}</code> views via
        the hosted API. Read-only — this panel never signs or mutates policy.
      </p>
      <LiveDataChrome />

      {loading && <p className="axis-supporting">Loading live mandate…</p>}
      {error && !mandate && (
        <p className="axis-supporting">
          Temporarily unavailable ({error}). Open Proof &amp; Verify for static
          Nearblocks links.
        </p>
      )}
      {isLastGood && (
        <p className="nio-disclosure" style={{ marginTop: 8 }}>
          Showing dated last-known-good state
          {mandate?.rpc_error ? ` after RPC issue: ${String(mandate.rpc_error)}` : ""}.
          Not labeled fresh.
        </p>
      )}

      {mandate?.ok ? (
        <>
          <div className="nio-flag-row" style={{ marginTop: 12 }}>
            <span
              className={`nio-badge ${
                mandate.paused === true
                  ? "nio-badge-warn"
                  : mandate.paused === false
                    ? "nio-badge-running"
                    : "nio-badge-idle"
              }`}
            >
              {flagLabel(mandate.paused, "PAUSED", "UNPAUSED")}
            </span>
            <span
              className={`nio-badge ${
                mandate.revoked === true
                  ? "nio-badge-danger"
                  : mandate.revoked === false
                    ? "nio-badge-success"
                    : "nio-badge-idle"
              }`}
            >
              {flagLabel(mandate.revoked, "REVOKED", "NOT_REVOKED")}
            </span>
            <span
              className={`nio-badge ${
                mandate.autonomous_trading === true
                  ? "nio-badge-success"
                  : mandate.autonomous_trading === false
                    ? "nio-badge-danger"
                    : "nio-badge-idle"
              }`}
            >
              AUTONOMY {flagLabel(mandate.autonomous_trading)}
            </span>
            <span className="nio-badge nio-badge-idle">
              enforce={flagLabel(mandate.enforce_autonomous_on_agent)}
            </span>
            <span className="nio-badge nio-badge-idle">
              state_version={safeText(mandate.state_version)}
            </span>
          </div>

          <dl className="nio-kv nio-kv-compact" style={{ marginTop: 14 }}>
            <div>
              <dt>Owner / Agent</dt>
              <dd className="mono">
                {safeText(mandate.owner)} / {safeText(mandate.agent)}
              </dd>
            </div>
            <div>
              <dt>Portfolio</dt>
              <dd className="mono">{safeText(mandate.portfolio_id)}</dd>
            </div>
            <div>
              <dt>Epoch</dt>
              <dd>{safeText(safeNumber(mandate.mandate_epoch))}</dd>
            </div>
            <div>
              <dt>Max trade</dt>
              <dd>
                {mandate.limits.max_trade_value != null
                  ? `${usdcLabel(mandate.limits.max_trade_value)} (${mandate.limits.max_trade_value} raw)`
                  : "temporarily unavailable"}
              </dd>
            </div>
            <div>
              <dt>Daily turnover</dt>
              <dd>
                {mandate.limits.daily_turnover_limit != null
                  ? `${usdcLabel(mandate.limits.daily_turnover_limit)} · spent ${usdcLabel(mandate.usage.daily_turnover)}`
                  : "temporarily unavailable"}
              </dd>
            </div>
            <div>
              <dt>Pending exposure</dt>
              <dd>
                {mandate.limits.max_pending_exposure != null
                  ? `cap ${usdcLabel(mandate.limits.max_pending_exposure)} · reserved ${usdcLabel(String(mandate.usage.reserved_pending_exposure))}`
                  : "temporarily unavailable"}
              </dd>
            </div>
            <div>
              <dt>Slippage / gas</dt>
              <dd>
                {mandate.limits.max_slippage_bps != null
                  ? `${mandate.limits.max_slippage_bps} bps`
                  : "—"}{" "}
                · {safeText(mandate.limits.max_gas_budget)}
              </dd>
            </div>
            <div>
              <dt>Expiry</dt>
              <dd>{expiry}</dd>
            </div>
            <div>
              <dt>Venues</dt>
              <dd>
                {(mandate.limits.allowed_venues || []).length
                  ? mandate.limits.allowed_venues.join(", ")
                  : "temporarily unavailable"}
              </dd>
            </div>
            <div>
              <dt>Destinations</dt>
              <dd className="mono">
                {(mandate.limits.allowed_destinations || []).length
                  ? mandate.limits.allowed_destinations.join(", ")
                  : "temporarily unavailable"}
              </dd>
            </div>
            <div>
              <dt>Chains (PERMITTED BY POLICY)</dt>
              <dd>
                {(mandate.limits.allowed_chains || []).length ? (
                  <div className="nio-chain-badges">
                    {mandate.limits.allowed_chains.map((c) => {
                      const b = chainBadge(c);
                      return (
                        <span key={c} className={`nio-badge nio-badge-${b.tone}`}>
                          {b.label}
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  "temporarily unavailable"
                )}
              </dd>
            </div>
            <div>
              <dt>Assets (canonical)</dt>
              <dd>
                {(mandate.limits.allowed_assets || []).length ? (
                  <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.8rem" }}>
                    {mandate.limits.allowed_assets.map((a) => (
                      <li key={a} className="mono">
                        {a}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "temporarily unavailable"
                )}
              </dd>
            </div>
          </dl>
          <p className="axis-supporting" style={{ marginTop: "1rem" }}>
            {freshnessLabel}. Allowlists are PERMITTED BY POLICY — not VERIFIED
            EXECUTION.
          </p>
        </>
      ) : !loading ? (
        <p className="axis-supporting" style={{ marginTop: 12 }}>
          Mandate temporarily unavailable. Retry from the live chrome above.
        </p>
      ) : null}
    </section>
  );
}
