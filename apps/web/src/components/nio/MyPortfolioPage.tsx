import { useEffect, useState } from "react";
import { lookupOwnerPortfolio } from "../../adapters/ownerAuth";
import { isWithdrawDeliveryEnabled } from "../../adapters/gatei";
import { MAINNET_EVIDENCE } from "../../data/mainnetEvidence";
import { evaluateDepositReadiness } from "../../lib/depositReadiness";
import { isDemoPortfolioId } from "../../lib/publicDemo";
import { abbreviateKey, useOwnerSession } from "../../state/OwnerSession";
import { OnboardingJourney } from "./OnboardingJourney";
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
              verified. The public demo portfolio remains separate and is never
              presented as your custody.
            </p>
          </div>
        </div>
        <OnboardingJourney
          input={{
            walletConnected: false,
            ownerVerified: false,
            withdrawDeliveryProven: isWithdrawDeliveryEnabled(),
            evidence: MAINNET_EVIDENCE,
          }}
          onNav={onNav}
        />
        <section className="axis-panel">
          <div className="nio-empty-state">
            <p>No verified owner session.</p>
            <p className="axis-supporting">
              Judges can explore Demo portfolio and Evidence without connecting
              hardware. Owner login requires a physical Ledger later. NEP-413
              alone does not authorize trading.
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

  const portfolioId = portfolio
    ? String(portfolio.portfolio_id ?? portfolio.id ?? "")
    : "";
  const ready =
    status === "ready" &&
    Boolean(portfolio) &&
    !isDemoPortfolioId(portfolioId);
  const awaiting =
    !ready &&
    (status === "blocked" ||
      status === "awaiting_operator" ||
      status === "queued_self" ||
      Boolean(reason));

  const policyContract = portfolio
    ? String(portfolio.policy_contract ?? "")
    : "";
  const intentsSigner = portfolio
    ? (portfolio.intents_signer_id as string | null | undefined) ?? null
    : null;
  const portfolioOwner = portfolio
    ? String(portfolio.owner_account ?? session?.account_id ?? "")
    : session?.account_id ?? null;

  const deposit = evaluateDepositReadiness({
    chain: "mainnet",
    ownerVerified: verified,
    ownerAccountId: session?.account_id,
    portfolioId: portfolioId || null,
    portfolioOwner,
    policyContract: policyContract || null,
    intentsSignerId: intentsSigner,
    backendReady: ready,
    portfolioStatus: status,
  });

  return (
    <div className="page-enter nio-my-portfolio-page">
      <div className="axis-intro">
        <div>
          <h1>My Portfolio</h1>
          <p>
            Owner-authenticated view for{" "}
            <span className="mono">{session?.account_id}</span>. Mutations that
            move funds stay disabled until their lifecycle is verified. Demo
            portfolios are never shown here as personal custody.
          </p>
        </div>
      </div>

      <OnboardingJourney
        input={{
          walletConnected: true,
          ownerVerified: verified,
          ownerAccountId: session?.account_id,
          portfolioStatus: status,
          portfolioId: portfolioId || null,
          portfolioOwner,
          policyContract: policyContract || null,
          intentsSignerId: intentsSigner,
          mandateOnChain: null,
          withdrawDeliveryProven: isWithdrawDeliveryEnabled(),
          evidence: MAINNET_EVIDENCE,
        }}
        onNav={onNav}
      />

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
            <dd>{session?.scheme ?? "nep413"} — ownership proof, not trading auth</dd>
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
              <dd className="mono">{portfolioId}</dd>
            </div>
            <div>
              <dt>Policy contract</dt>
              <dd className="mono">{policyContract || "—"}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd className="mono">{portfolioOwner}</dd>
            </div>
            <div>
              <dt>MPC address</dt>
              <dd className="mono">
                {deposit.allowed && intentsSigner
                  ? intentsSigner
                  : "Withheld until deposit readiness verified"}
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
              fake success — an operator must provision or register the policy
              account.
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
          <h2>Recovery & limitations</h2>
          <span className="nio-badge nio-badge-warn">HONEST SCOPE</span>
        </div>
        <dl className="nio-kv">
          <div>
            <dt>Owner account</dt>
            <dd className="mono">{session?.account_id}</dd>
          </div>
          <div>
            <dt>Contract account</dt>
            <dd className="mono">
              {policyContract ||
                MAINNET_EVIDENCE.contract.account_id ||
                "Not verified"}
            </dd>
          </div>
          <div>
            <dt>Supported networks (product)</dt>
            <dd>NEAR testnet demo · mainnet deposits blocked</dd>
          </div>
          <div>
            <dt>Confirmed assets</dt>
            <dd>None shown until live personal balances are readable</dd>
          </div>
          <div>
            <dt>Pending settlements</dt>
            <dd>No public funded settlement journal in this UI</dd>
          </div>
          <div>
            <dt>Revoke / pause</dt>
            <dd>Available via Ledger wizard after provision — not on public BFF</dd>
          </div>
          <div>
            <dt>Exported-signature limitation</dt>
            <dd>
              Revoke stops new signatures; already-exported ECDSA txs may still
              broadcast
            </dd>
          </div>
          <div>
            <dt>Independent recovery</dt>
            <dd>
              Not claimed as always available — requires FullAccess on policy +
              known addresses; product path incomplete
            </dd>
          </div>
        </dl>
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Lifecycle controls</h2>
          <span className="nio-badge nio-badge-danger">LOCKED</span>
        </div>
        <p className="warn" style={{ marginBottom: 10 }}>
          {deposit.message}
        </p>
        <ul className="nio-owner-actions">
          <li>
            Deposit address issuance — blocked until every readiness gate passes
          </li>
          <li>
            Withdrawals — disabled until delivery proven + owner signature
          </li>
          <li>Policy updates / revoke — Ledger wizard after provision only</li>
          <li>Agent start/stop — owner session required; funded autonomy OFF</li>
          <li>Gate K signing / autonomous mode — OFF</li>
        </ul>
      </section>
    </div>
  );
}
