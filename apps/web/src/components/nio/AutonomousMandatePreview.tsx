import { useEffect, useState } from "react";
import {
  fetchMainnetMandate,
  usdcLabel,
  chainBadge,
  type MainnetMandate,
} from "../../adapters/mainnetPublic";

/**
 * Live on-chain mandate panel (read-only). Falls back to last-known evidence
 * labels when API is unreachable — never claims PASS without live/on-chain data.
 */
export function AutonomousMandatePreview() {
  const [mandate, setMandate] = useState<MainnetMandate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchMainnetMandate()
      .then((m) => {
        if (!cancelled) setMandate(m);
      })
      .catch((e) => {
        if (!cancelled) setError(String((e as Error).message || e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const expiry =
    mandate?.expiry?.expires_in_ms != null
      ? `${Math.floor(mandate.expiry.expires_in_ms / 3600_000)}h remaining`
      : "—";

  return (
    <section className="nio-card" style={{ marginTop: "1.5rem" }}>
      <h2 style={{ marginTop: 0 }}>Live on-chain mandate</h2>
      <p style={{ opacity: 0.85 }}>
        Sourced from <code>policy.nishanthb.near</code> views via the hosted API. Read-only —
        this panel never signs or mutates policy.
      </p>

      {loading && <p className="axis-supporting">Loading live mandate…</p>}
      {error && (
        <p className="axis-supporting">
          Live API error: {error}. Open Proof &amp; Verify for static Nearblocks links.
        </p>
      )}

      {mandate?.ok && (
        <>
          <p>
            <span className="nio-badge nio-badge-success">MAINNET</span>{" "}
            <span className="nio-badge nio-badge-running">
              {mandate.paused ? "PAUSED" : "UNPAUSED"}
            </span>{" "}
            <span className="nio-badge nio-badge-recorded">
              {mandate.autonomous_trading ? "AUTONOMOUS" : "AUTONOMY_OFF"}
            </span>{" "}
            <span className="nio-badge nio-badge-idle">
              enforce={String(mandate.enforce_autonomous_on_agent)}
            </span>
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
            <tbody>
              <tr>
                <td>Owner / Agent</td>
                <td className="mono">
                  {mandate.owner} / {mandate.agent}
                </td>
              </tr>
              <tr>
                <td>Epoch</td>
                <td>{mandate.mandate_epoch}</td>
              </tr>
              <tr>
                <td>Max trade</td>
                <td>
                  {usdcLabel(mandate.limits.max_trade_value)} (
                  {mandate.limits.max_trade_value} raw)
                </td>
              </tr>
              <tr>
                <td>Daily turnover</td>
                <td>
                  {usdcLabel(mandate.limits.daily_turnover_limit)} · spent{" "}
                  {usdcLabel(
                    typeof mandate.usage.daily_turnover === "object"
                      ? String(
                          (mandate.usage.daily_turnover as { toString?: () => string }) || "0"
                        )
                      : mandate.usage.daily_turnover
                  )}
                </td>
              </tr>
              <tr>
                <td>Pending exposure</td>
                <td>
                  cap {usdcLabel(mandate.limits.max_pending_exposure)} · reserved{" "}
                  {usdcLabel(String(mandate.usage.reserved_pending_exposure))}
                </td>
              </tr>
              <tr>
                <td>Slippage / gas</td>
                <td>
                  {mandate.limits.max_slippage_bps} bps · {mandate.limits.max_gas_budget}
                </td>
              </tr>
              <tr>
                <td>Expiry</td>
                <td>{expiry}</td>
              </tr>
              <tr>
                <td>Venues</td>
                <td>{(mandate.limits.allowed_venues || []).join(", ")}</td>
              </tr>
              <tr>
                <td>Destinations</td>
                <td className="mono">
                  {(mandate.limits.allowed_destinations || []).join(", ")}
                </td>
              </tr>
              <tr>
                <td>Chains (PERMITTED BY POLICY)</td>
                <td>
                  <div className="nio-chain-badges">
                    {(mandate.limits.allowed_chains || []).map((c) => {
                      const b = chainBadge(c);
                      return (
                        <span key={c} className={`nio-badge nio-badge-${b.tone}`}>
                          {b.label}
                        </span>
                      );
                    })}
                  </div>
                </td>
              </tr>
              <tr>
                <td>Assets (canonical)</td>
                <td>
                  <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.8rem" }}>
                    {(mandate.limits.allowed_assets || []).map((a) => (
                      <li key={a} className="mono">
                        {a}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            </tbody>
          </table>
          <p style={{ marginTop: "1rem", fontSize: "0.85rem", opacity: 0.8 }}>
            Fetched {mandate.fetched_at}
            {mandate.fresh ? " (fresh)" : " (cached)"}. Allowlists are PERMITTED BY POLICY —
            not VERIFIED EXECUTION.
          </p>
        </>
      )}
    </section>
  );
}
