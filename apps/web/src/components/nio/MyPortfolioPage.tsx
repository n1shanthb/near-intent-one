import { useEffect, useState } from "react";
import { lookupOwnerPortfolio } from "../../adapters/ownerAuth";
import { abbreviateKey, useOwnerSession } from "../../state/OwnerSession";
import type { NavId } from "./nav";

function portfolioTone(status: string, ready: boolean): string {
  if (ready) return "nio-badge-success";
  if (status === "blocked" || status === "awaiting_operator" || status === "queued_self") {
    return "nio-badge-warn";
  }
  return "nio-badge-idle";
}

function humanPortfolioStatus(status: string, ready: boolean): string {
  if (ready) return "PERSONAL PORTFOLIO READY";
  if (status === "awaiting_operator" || status === "queued_self") {
    return "AWAITING PROVISIONING";
  }
  if (status === "blocked") return "AWAITING PROVISIONING";
  if (status === "idle") return "IDLE";
  return status.toUpperCase();
}

export function MyPortfolioPage({ onNav }: { onNav: (id: NavId) => void }) {
  const { session, verified, clearOwner } = useOwnerSession();
  const [status, setStatus] = useState<string>("idle");
  const [reason, setReason] = useState<string | null>(null);
  const [portfolio, setPortfolio] = useState<Record<string, unknown> | null>(
    null
  );
  const [nextAction, setNextAction] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!verified || !session?.account_id) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await lookupOwnerPortfolio(session.account_id!);
        if (cancelled) return;
        setStatus(res.status);
        setReason(res.reason ?? null);
        setPortfolio(res.portfolio ?? null);
        setNextAction(res.next_action ?? null);
      } catch (e) {
        if (!cancelled) {
          setStatus("blocked");
          setReason(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [verified, session?.account_id]);

  if (!verified) {
    return (
      <div className="page-enter nio-my-portfolio-page">
        <div className="axis-intro">
          <div>
            <h1>My Portfolio</h1>
            <p>
              Personal portfolio data is shown only after Ledger ownership is
              verified. The public demo portfolio remains separate.
            </p>
          </div>
        </div>
        <section className="axis-panel">
          <div className="nio-empty-state">
            <p>No verified owner session.</p>
            <p className="axis-supporting">
              Judges can explore Demo portfolio and Evidence without connecting
              hardware. Owner login requires a physical Ledger later.
            </p>
            <div className="axis-actions" style={{ justifyContent: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                className="axis-button"
                onClick={() => onNav("owner")}
              >
                Connect Ledger → Verify ownership
              </button>
              <button
                type="button"
                className="axis-button secondary"
                onClick={() => onNav("portfolio")}
              >
                Open demo portfolio
              </button>
              <button
                type="button"
                className="axis-button secondary"
                onClick={() => onNav("evidence")}
              >
                View recorded Gate K proof
              </button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const ready = status === "ready" && Boolean(portfolio);
  const awaiting =
    !ready &&
    (status === "blocked" ||
      status === "awaiting_operator" ||
      status === "queued_self" ||
      Boolean(reason));

  return (
    <div className="page-enter nio-my-portfolio-page">
      <div className="axis-intro">
        <div>
          <h1>My Portfolio</h1>
          <p>
            Owner-authenticated view for{" "}
            <span className="mono">{session?.account_id}</span>. Mutations that
            move funds stay disabled until their lifecycle is verified.
          </p>
        </div>
      </div>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Owner binding</h2>
          <span className="nio-badge nio-badge-success">SESSION ACTIVE</span>
        </div>
        <dl className="nio-kv">
          <div>
            <dt>Account</dt>
            <dd className="mono">{session?.account_id}</dd>
          </div>
          <div>
            <dt>Public key</dt>
            <dd className="mono">{abbreviateKey(session?.public_key)}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd className="mono">{session?.expires_at ?? "—"}</dd>
          </div>
          <div>
            <dt>Scheme</dt>
            <dd>{session?.scheme ?? "nep413"}</dd>
          </div>
        </dl>
        <div className="axis-actions" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("owner")}
          >
            Owner authentication
          </button>
          <button
            type="button"
            className="axis-button danger"
            onClick={() => void clearOwner()}
          >
            Logout owner session
          </button>
        </div>
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Portfolio record</h2>
          <span className={`nio-badge ${portfolioTone(status, ready)}`}>
            {loading ? "LOADING" : humanPortfolioStatus(status, ready)}
          </span>
        </div>

        {loading ? (
          <p className="axis-supporting">Looking up owner portfolio…</p>
        ) : ready ? (
          <dl className="nio-kv">
            <div>
              <dt>Portfolio id</dt>
              <dd className="mono">
                {String(portfolio!.portfolio_id ?? portfolio!.id ?? "—")}
              </dd>
            </div>
            <div>
              <dt>Policy contract</dt>
              <dd className="mono">
                {String(portfolio!.policy_contract ?? "—")}
              </dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd className="mono">
                {String(portfolio!.owner_account ?? session?.account_id)}
              </dd>
            </div>
            {nextAction ? (
              <div>
                <dt>Next action</dt>
                <dd>{nextAction}</dd>
              </div>
            ) : null}
          </dl>
        ) : awaiting ? (
          <div className="nio-empty-state">
            <p>
              <strong>Portfolio awaiting provisioning.</strong> Ownership is
              verified, but no personal portfolio row is ready yet. This is not a
              fake success.
            </p>
            <p className="axis-supporting">
              {reason ||
                "Operator provision or register is still required on this host."}
            </p>
            {nextAction ? (
              <p className="axis-supporting mono">next · {nextAction}</p>
            ) : null}
            <div className="axis-actions" style={{ justifyContent: "center" }}>
              <button
                type="button"
                className="axis-button secondary"
                onClick={() => onNav("portfolio")}
              >
                Browse public demo portfolio
              </button>
            </div>
          </div>
        ) : (
          <div className="nio-empty-state">
            <p>No portfolio data for this owner yet.</p>
          </div>
        )}
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Lifecycle controls</h2>
          <span className="nio-badge nio-badge-danger">LOCKED</span>
        </div>
        <ul className="nio-owner-actions">
          <li>
            Deposit address issuance — disabled until provisioned portfolio +
            deposit lifecycle verified
          </li>
          <li>
            Withdrawals — disabled (requires on-chain owner signature; public
            gateway does not expose submit)
          </li>
          <li>Policy updates / revoke — disabled on this surface</li>
          <li>Gate K signing / autonomous mode — OFF</li>
        </ul>
      </section>
    </div>
  );
}
