import { useEffect, useState } from "react";
import { ExternalLink, Store } from "lucide-react";
import {
  fetchMainnetCommerceStatus,
  type MainnetCommerceStatus,
} from "../../adapters/mainnetPublic";
import { StatusBadge, MetricCard } from "./uiPrimitives";

function stateTone(
  state: string
): "success" | "warn" | "danger" | "idle" | "running" | "recorded" {
  const s = state.toUpperCase();
  if (s === "ACCEPTED" || s === "DELIVERED") return "success";
  if (s === "IN_PROGRESS" || s === "HIRED" || s === "PAYMENT_PENDING") return "running";
  if (s === "FAILED" || s === "DISPUTED" || s === "REFUNDED") return "danger";
  return "idle";
}

export function CommercePanel() {
  const [data, setData] = useState<MainnetCommerceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const out = await fetchMainnetCommerceStatus();
        if (!cancelled) {
          setData(out);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "commerce_unavailable");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const jobs = data?.jobs || [];
  const paid = jobs.filter((j) => Number(j.paid_amount_usdc || 0) > 0 && !j.mock);
  const budget = data?.budget;
  const gates = data?.gates;

  return (
    <section className="axis-panel">
      <div className="axis-panel-heading">
        <h2>
          <Store size={18} style={{ marginRight: 8, verticalAlign: -3 }} />
          Agent economy
        </h2>
        <StatusBadge
          tone={
            paid.length
              ? "success"
              : data?.buyer_token_present
                ? "warn"
                : "idle"
          }
        >
          {paid.length
            ? "MARKETPLACE HIRE LIVE"
            : data?.ok
              ? "COMMERCE READY"
              : "LOADING"}
        </StatusBadge>
      </div>
      <p>
        NIO Commerce Agent hires specialists on{" "}
        <a href="https://market.near.ai" target="_blank" rel="noreferrer">
          market.near.ai
        </a>{" "}
        with a separate budget from DeFi trading. External agent output is
        untrusted research context only.
      </p>

      <div
        className="axis-stats"
        style={{
          gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))",
          marginTop: 12,
        }}
      >
        <MetricCard
          label="Commerce budget left"
          value={`$${(budget?.available_budget_usdc ?? gates?.daily_budget_usdc ?? 0.5).toFixed(2)}`}
          hint={`cap $${(gates?.max_price_per_hire_usdc ?? 0.5).toFixed(2)} / job · ${gates?.max_jobs_total ?? 1} job max`}
        />
        <MetricCard
          label="Spent"
          value={`$${(budget?.spent_usdc ?? 0).toFixed(2)} USDC`}
          hint={`${budget?.jobs_count ?? paid.length} hire(s) · escrow rail`}
        />
        <MetricCard
          label="Payments flag"
          value={gates?.payments_enabled ? "ON" : "OFF"}
          hint="Mutations stay separately authorized"
        />
        <MetricCard
          label="Agents hired"
          value={String(paid.length)}
          hint={paid.length ? "real marketplace escrow" : "zero until paid"}
        />
      </div>

      {error ? (
        <p className="warn" style={{ marginTop: 12 }}>
          Live commerce API: {error} — showing committed snapshot when available.
        </p>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: 15, margin: "0 0 8px" }}>Hired agents</h3>
        {paid.length === 0 ? (
          <p className="axis-supporting">
            No paid marketplace purchases yet.
          </p>
        ) : (
          <div className="nio-commerce-jobs">
            {paid.map((job) => (
              <article
                key={job.operation_id || job.market_job_id || job.agent_id}
                className="nio-commerce-job"
                style={{
                  borderTop: "1px solid var(--axis-border, #dbe7f3)",
                  paddingTop: 12,
                  marginTop: 12,
                }}
              >
                <div className="axis-panel-heading" style={{ marginBottom: 6 }}>
                  <strong>
                    {job.agent_name || job.agent_handle || "Agent"}
                  </strong>
                  <StatusBadge tone={stateTone(job.state || "")}>
                    {job.state || "UNKNOWN"}
                  </StatusBadge>
                </div>
                <dl className="axis-overview-catalog" style={{ margin: 0 }}>
                  <div>
                    <dt>Handle</dt>
                    <dd className="mono">{job.agent_handle || "—"}</dd>
                  </div>
                  <div>
                    <dt>Paid</dt>
                    <dd>
                      {job.paid_amount_usdc} {job.currency || "USDC"}
                    </dd>
                  </div>
                  <div>
                    <dt>Quoted</dt>
                    <dd>
                      {job.quoted_price_usdc} {job.currency || "USDC"}
                    </dd>
                  </div>
                  <div>
                    <dt>Rail</dt>
                    <dd className="mono">{job.payment_rail || "marketplace_escrow"}</dd>
                  </div>
                  <div>
                    <dt>Job ID</dt>
                    <dd className="mono">{job.market_job_id || "—"}</dd>
                  </div>
                  <div>
                    <dt>Activity</dt>
                    <dd>{job.activity_type || "AGENT MARKET PURCHASE"}</dd>
                  </div>
                </dl>
                {job.brief_summary ? (
                  <p className="axis-supporting" style={{ marginTop: 8 }}>
                    {job.brief_summary}
                  </p>
                ) : null}
                <div className="axis-actions" style={{ marginTop: 10 }}>
                  {job.listing_url ? (
                    <a
                      className="axis-button secondary"
                      href={job.listing_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Listing <ExternalLink size={14} />
                    </a>
                  ) : null}
                  {job.job_url || job.tx_url ? (
                    <a
                      className="axis-button"
                      href={job.job_url || job.tx_url || "#"}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Marketplace receipt <ExternalLink size={14} />
                    </a>
                  ) : null}
                </div>
                {job.delivery_hash ? (
                  <p className="mono" style={{ marginTop: 8, fontSize: 12 }}>
                    Delivery hash: {job.delivery_hash}
                  </p>
                ) : (
                  <p className="axis-supporting" style={{ marginTop: 8 }}>
                    Deliverable pending — worker still in progress.
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
