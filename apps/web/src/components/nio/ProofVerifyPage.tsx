import { useEffect, useState } from "react";
import {
  fetchMainnetDecisions,
  fetchMainnetProof,
  fetchMainnetTransactions,
  fetchMainnetMandate,
  type MainnetDecisionSummary,
} from "../../adapters/mainnetPublic";
import type { NavId } from "./nav";

function Badge({ children, kind }: { children: string; kind?: string }) {
  return (
    <span className={`nio-badge nio-badge-${kind || "neutral"}`}>{children}</span>
  );
}

export function ProofVerifyPage({ onNav }: { onNav: (id: NavId) => void }) {
  const [txs, setTxs] = useState<Awaited<ReturnType<typeof fetchMainnetTransactions>> | null>(null);
  const [mandate, setMandate] = useState<Awaited<ReturnType<typeof fetchMainnetMandate>> | null>(null);
  const [decisions, setDecisions] = useState<MainnetDecisionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [proof, setProof] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, m, d] = await Promise.all([
          fetchMainnetTransactions(),
          fetchMainnetMandate(),
          fetchMainnetDecisions(30),
        ]);
        if (cancelled) return;
        setTxs(t);
        setMandate(m);
        setDecisions(d.decisions || []);
        if (d.decisions?.[0]?.cycle_id) setSelected(d.decisions[0].cycle_id);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setProof(null);
    fetchMainnetProof(selected)
      .then((p) => {
        if (!cancelled) setProof(p);
      })
      .catch((e) => {
        if (!cancelled) setProof({ ok: false, reason: String(e.message || e) });
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <section className="axis-panel">
      <div className="axis-panel-heading">
        <h2>Proof &amp; Verify</h2>
        <p className="axis-supporting">
          Public mainnet audit trail — no wallet required. Audit receipt ≠ settled swap.
        </p>
      </div>

      {loading && <p className="axis-supporting">Loading live mainnet proofs…</p>}
      {error && (
        <p className="axis-supporting">
          Live API unavailable ({error}). Governance txs below are still independently
          verifiable on Nearblocks.
        </p>
      )}

      <div className="nio-proof-grid">
        <div>
          <h3>Governance transactions</h3>
          <ul className="nio-tx-list">
            {(txs?.governance || []).map((g) => (
              <li key={g.tx}>
                <Badge kind="mainnet">{g.label}</Badge> {g.kind}{" "}
                <a href={g.explorer} target="_blank" rel="noreferrer" className="mono">
                  {g.tx.slice(0, 12)}…
                </a>
              </li>
            ))}
            {!txs?.governance?.length && (
              <>
                <li>
                  <a
                    href="https://nearblocks.io/txns/7rxXmYqbDL7HyBtG2EKo4g1xHbJYptphg9jMLU7Konrf"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Deploy WASM
                  </a>
                </li>
                <li>
                  <a
                    href="https://nearblocks.io/txns/6zQs6C56tdPYz5BYY9Ca2T4XusU5oavt1gDw3tdDaW93"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Activate mandate
                  </a>
                </li>
              </>
            )}
          </ul>
          <p className="axis-supporting">{txs?.supervised_canaries_note}</p>
        </div>

        <div>
          <h3>Live mandate snapshot</h3>
          {mandate?.ok ? (
            <ul className="nio-kv">
              <li>
                Epoch <strong>{mandate.mandate_epoch}</strong>{" "}
                <Badge kind={mandate.paused ? "warn" : "ok"}>
                  {mandate.paused ? "PAUSED" : "UNPAUSED"}
                </Badge>
              </li>
              <li>
                <Badge kind="autonomous">
                  {mandate.autonomous_trading ? "AUTONOMOUS" : "NOT_AUTONOMOUS"}
                </Badge>{" "}
                <Badge kind="enforce">
                  enforce={String(mandate.enforce_autonomous_on_agent)}
                </Badge>
              </li>
              <li>
                Max trade {String(mandate.limits.max_trade_value)} raw · Daily{" "}
                {String(mandate.limits.daily_turnover_limit)}
              </li>
              <li className="mono">Policy {mandate.policy}</li>
            </ul>
          ) : (
            <p className="axis-supporting">Mandate view pending live API.</p>
          )}
          <button type="button" className="axis-btn" onClick={() => onNav("mandate")}>
            Open mandate
          </button>
        </div>
      </div>

      <h3>Decision cycles</h3>
      <div className="nio-decision-list">
        {decisions.length === 0 && (
          <p className="axis-supporting">
            No anchored decision records in OCI store yet. After audit WASM upgrade +
            keeper cycle, receipts appear here.
          </p>
        )}
        {decisions.map((d) => (
          <button
            type="button"
            key={d.cycle_id}
            className={`nio-decision-row ${selected === d.cycle_id ? "active" : ""}`}
            onClick={() => setSelected(d.cycle_id)}
          >
            <span className="mono">{d.cycle_id.slice(0, 28)}…</span>
            <Badge kind={d.final_action === "TRADE" ? "trade" : "notrade"}>
              {d.final_action}
            </Badge>
            <Badge kind="fitter">{d.fitter_verdict}</Badge>
            <Badge kind="status">{d.status}</Badge>
          </button>
        ))}
      </div>

      {proof && (
        <div className="nio-proof-detail">
          <h3>Selected proof</h3>
          <ul className="nio-kv">
            <li>
              Status{" "}
              <Badge kind="status">{String(proof.status || "UNKNOWN")}</Badge>
            </li>
            <li className="mono">
              Off-chain hash {String(proof.offchain_evidence_hash || "—")}
            </li>
            <li>Recompute OK: {String(proof.recomputed_ok)}</li>
            <li>On-chain hash match: {String(proof.hash_match)}</li>
            {proof.explorer ? (
              <li>
                <a href={String(proof.explorer)} target="_blank" rel="noreferrer">
                  Open Nearblocks receipt
                </a>
              </li>
            ) : null}
            <li className="axis-supporting">{String(proof.note || "")}</li>
          </ul>
        </div>
      )}
    </section>
  );
}
