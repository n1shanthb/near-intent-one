import { useState } from "react";
import { useNearWallet } from "near-connect-hooks";
import { createPortfolio, getPortfolio } from "../adapters/gatei";
import { CONFIG } from "../lib/config";
import { useProductSession } from "../state/ProductSession";
import { GateIBanner } from "./GateIBanner";
import type { NavId } from "./Shell";

export function Portfolio({ onNav }: { onNav: (id: NavId) => void }) {
  const { signedAccountId, signIn } = useNearWallet();
  const { authMode, portfolio, setPortfolio, gateI, refreshGateI } =
    useProductSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextAction, setNextAction] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    setNextAction(null);
    if (!signedAccountId) {
      setError("Connect a wallet first.");
      return;
    }
    if (authMode === "demo") {
      setError("Demo mode cannot create a personal portfolio. Choose Ledger or NEAR wallet.");
      return;
    }
    setBusy(true);
    try {
      await refreshGateI();
      const res = await createPortfolio({
        owner_account: signedAccountId,
        auth_mode: authMode ?? "near_wallet",
      });
      if (res.status === "blocked") {
        setError(res.reason);
        return;
      }
      setPortfolio(res.portfolio);
      setNextAction(res.next_action ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!portfolio) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await getPortfolio(portfolio.portfolio_id);
      if (!fresh) {
        setError(
          "Could not refresh portfolio — live API unreachable or portfolio not found."
        );
        return;
      }
      setPortfolio(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h3>Personal portfolio</h3>
          <span className="badge badge-warn">INDEPENDENT GOVERNANCE</span>
        </div>
        <p>
          Create an account you own. Deployment uses Gate I — not the shared demo
          policy <span className="mono">{CONFIG.policyContract}</span>.
        </p>
        <p className="muted small">
          Testnet gas: you need a small NEAR balance on the connected owner account
          to pay deploy / function-call fees when Gate I asks for signatures.
        </p>
      </section>

      <GateIBanner action="Portfolio create / deploy" />

      {!signedAccountId ? (
        <section className="card">
          <p>Connect a tested NEAR wallet to continue.</p>
          <button type="button" onClick={() => void signIn()}>
            Connect NEAR wallet
          </button>
          <button type="button" className="ghost" onClick={() => onNav("welcome")}>
            Back to Welcome
          </button>
        </section>
      ) : null}

      {signedAccountId && !portfolio ? (
        <section className="card">
          <dl className="kv dense">
            <dt>Owner identity</dt>
            <dd className="mono">{signedAccountId}</dd>
            <dt>Auth mode</dt>
            <dd>{authMode ?? "near_wallet (default)"}</dd>
            <dt>Demo custody</dt>
            <dd className="mono muted">
              {CONFIG.policyContract} — not used for your funds
            </dd>
          </dl>
          <button
            type="button"
            disabled={busy || gateI.status !== "available"}
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create personal portfolio"}
          </button>
          {gateI.status !== "available" ? (
            <p className="muted small">
              Blocked: Gate I API not available. No fake deploy success will be shown.
            </p>
          ) : null}
        </section>
      ) : null}

      {portfolio ? (
        <section className="card">
          <div className="card-head">
            <h3>Your portfolio</h3>
            <span
              className={`badge ${
                portfolio.deploy_status === "ready"
                  ? "badge-pass"
                  : portfolio.deploy_status === "failed"
                    ? "badge-danger"
                    : "badge-warn"
              }`}
            >
              {portfolio.deploy_status}
            </span>
          </div>
          <dl className="kv dense">
            <dt>Portfolio id</dt>
            <dd className="mono">{portfolio.portfolio_id}</dd>
            <dt>Owner</dt>
            <dd className="mono">{portfolio.owner_account}</dd>
            <dt>Policy account</dt>
            <dd className="mono">{portfolio.policy_contract}</dd>
            <dt>Agent</dt>
            <dd className="mono">{portfolio.agent_account ?? "—"}</dd>
            <dt>Reconciler</dt>
            <dd className="mono">{portfolio.reconciler_account ?? "—"}</dd>
            <dt>Derivation path</dt>
            <dd className="mono">{portfolio.derivation_path}</dd>
            <dt>Intents / EVM id</dt>
            <dd className="mono">{portfolio.intents_signer_id ?? "pending"}</dd>
            <dt>Network</dt>
            <dd>{portfolio.network}</dd>
          </dl>

          <h4>Deployment transactions</h4>
          {portfolio.deploy_txs.length === 0 ? (
            <p className="muted">No deploy receipts yet from Gate I.</p>
          ) : (
            <ul className="demo-list">
              {portfolio.deploy_txs.map((tx, i) => (
                <li key={`${tx.label}-${tx.tx_hash ?? i}`}>
                  <strong>{tx.label}</strong>{" "}
                  {tx.tx_hash ? (
                    <a
                      href={`${CONFIG.nearblocks}/txns/${tx.tx_hash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                    >
                      {tx.tx_hash.slice(0, 16)}…
                    </a>
                  ) : (
                    <span className="muted">
                      (hash not in provision payload — account already ready)
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {nextAction ? (
            <p className="warn">Next action from Gate I: {nextAction}</p>
          ) : null}

          <div className="row gap">
            <button type="button" disabled={busy} onClick={() => void refresh()}>
              Refresh status
            </button>
            <button
              type="button"
              disabled={portfolio.deploy_status !== "ready"}
              onClick={() => onNav("funds")}
            >
              Deposit / withdraw
            </button>
            <button type="button" className="ghost" onClick={() => onNav("policies")}>
              Set policy
            </button>
          </div>
        </section>
      ) : null}

      {error ? (
        <section className="card alert">
          <p>{error}</p>
        </section>
      ) : null}
    </div>
  );
}
