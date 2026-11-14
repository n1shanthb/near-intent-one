import { useEffect, useState } from "react";
import {
  fetchMainnetProof,
  type MainnetDecisionSummary,
} from "../../adapters/mainnetPublic";
import {
  formatLastUpdated,
  useWorkspace,
} from "../../state/WorkspaceContext";
import { LiveDataChrome } from "./WorkspaceSwitcher";
import type { NavId } from "./nav";

function Badge({ children, kind }: { children: string; kind?: string }) {
  return (
    <span className={`nio-badge nio-badge-${kind || "neutral"}`}>{children}</span>
  );
}

function verifiedStatusLabel(proof: Record<string, unknown> | null): string {
  if (!proof) return "PENDING";
  if (proof.ok === false) return "UNAVAILABLE";
  if (proof.hash_match === true && proof.recomputed_ok === true) {
    return "ONCHAIN_VERIFIED";
  }
  if (proof.hash_match === false) return "ONCHAIN_MISMATCH";
  return String(proof.status || "PENDING");
}

export function ProofVerifyPage({ onNav }: { onNav: (id: NavId) => void }) {
  const { isPublic, live, personalProvisioned, identities } = useWorkspace();
  const [selected, setSelected] = useState<string | null>(null);
  const [proof, setProof] = useState<Record<string, unknown> | null>(null);

  const txs = isPublic ? live.transactions : null;
  const mandate = isPublic ? live.mandate : null;
  const decisions: MainnetDecisionSummary[] = isPublic ? live.decisions : [];
  const loading = isPublic && live.status === "loading" && !mandate;
  const error = isPublic ? live.error : null;

  useEffect(() => {
    if (decisions[0]?.cycle_id && !selected) {
      setSelected(decisions[0].cycle_id);
    }
  }, [decisions, selected]);

  useEffect(() => {
    if (!isPublic || !selected) return;
    let cancelled = false;
    setProof(null);
    fetchMainnetProof(selected)
      .then((p) => {
        if (cancelled) return;
        // Never claim ONCHAIN_VERIFIED on mismatch / failure
        if (p && p.hash_match === false) {
          setProof({ ...p, status: "ONCHAIN_MISMATCH" });
        } else {
          setProof(p);
        }
      })
      .catch((e) => {
        if (!cancelled)
          setProof({
            ok: false,
            reason: String(e.message || e),
            status: "UNAVAILABLE",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [selected, isPublic]);

  if (!isPublic) {
    return (
      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Proof &amp; Verify</h2>
          <span className="nio-badge nio-badge-warn">PERSONAL</span>
        </div>
        <p className="axis-supporting">
          {personalProvisioned
            ? `Proof history for ${identities.portfolio_id ?? "your portfolio"} appears when your policy emits audit receipts.`
            : "Personal agent not provisioned — no proof history yet. This page never shows Nishanth's audit trail while you are in personal workspace."}
        </p>
        <div className="axis-actions">
          <button type="button" className="axis-button" onClick={() => onNav("owner")}>
            Owner auth
          </button>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("my-portfolio")}
          >
            My Portfolio
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="axis-panel">
      <div className="axis-panel-heading">
        <h2>Proof &amp; Verify</h2>
        <p className="axis-supporting">
          Public mainnet audit trail for {identities.policy} — no wallet required.
          Audit receipt ≠ settled swap. Updated {formatLastUpdated(live.lastUpdated)}.
        </p>
      </div>
      <LiveDataChrome />

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
                <li>
                  <a
                    href="https://nearblocks.io/txns/4oM5UGjwk8vtUzJ6cjo6bhY1zWaaGSMtD8c2LDC2Tb3G"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Audit WASM upgrade
                  </a>
                </li>
                <li>
                  <a
                    href="https://nearblocks.io/txns/CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s"
                    target="_blank"
                    rel="noreferrer"
                  >
                    NO_TRADE audit proof
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
                  {`enforce=${String(mandate.enforce_autonomous_on_agent)}`}
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
            No anchored decision records in OCI store yet.
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
              <Badge kind="status">{verifiedStatusLabel(proof)}</Badge>
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
