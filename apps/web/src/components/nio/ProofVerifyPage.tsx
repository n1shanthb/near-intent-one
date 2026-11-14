import { useEffect, useState } from "react";
import {
  fetchMainnetProof,
  flagLabel,
  type MainnetDecisionSummary,
} from "../../adapters/mainnetPublic";
import {
  formatLastUpdated,
  useWorkspace,
} from "../../state/WorkspaceContext";
import { LiveDataChrome } from "./WorkspaceSwitcher";
import {
  EvidenceTimeline,
  MetricCard,
  StatusBadge,
  governanceTitle,
} from "./uiPrimitives";
import type { NavId } from "./nav";

function Badge({ children, kind }: { children: string; kind?: string }) {
  return (
    <span className={`nio-badge nio-badge-${kind || "neutral"}`}>{children}</span>
  );
}

function statusExplain(status: string, proof: Record<string, unknown> | null): string {
  if (proof?.status_explain && typeof proof.status_explain === "string") {
    return proof.status_explain;
  }
  if (status === "ONCHAIN_VERIFIED") {
    return "On-chain evidence hash matches the off-chain record and verification succeeded.";
  }
  if (status === "ONCHAIN_MISMATCH") {
    return "An on-chain record exists but the evidence hash does not match.";
  }
  if (status === "OFFCHAIN_ONLY") {
    return "Decision recorded locally; no NEAR receipt exists.";
  }
  if (status === "UNAVAILABLE") {
    return "Proof lookup temporarily unavailable.";
  }
  return "";
}

function verifiedStatusLabel(proof: Record<string, unknown> | null): string {
  if (!proof) return "PENDING";
  if (proof.ok === false) return "UNAVAILABLE";
  // ONCHAIN_VERIFIED requires matching hash AND successful recompute — never cache PASS after failure
  if (
    proof.hash_match === true &&
    proof.recomputed_ok === true &&
    (proof.status === "ONCHAIN_VERIFIED" || proof.status == null)
  ) {
    return "ONCHAIN_VERIFIED";
  }
  if (proof.hash_match === false && proof.onchain_lookup) {
    return "ONCHAIN_MISMATCH";
  }
  if (proof.hash_match === false && !proof.onchain_lookup) {
    return "OFFCHAIN_ONLY";
  }
  const s = String(proof.status || "PENDING");
  if (s === "ONCHAIN_VERIFIED" && proof.hash_match !== true) {
    return "OFFCHAIN_ONLY";
  }
  return s;
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
        if (!p) {
          setProof({ ok: false, status: "UNAVAILABLE" });
          return;
        }
        if (p.hash_match === true && p.recomputed_ok === true) {
          setProof({ ...p, status: "ONCHAIN_VERIFIED" });
        } else if (p.hash_match === false && p.onchain_lookup) {
          setProof({ ...p, status: "ONCHAIN_MISMATCH" });
        } else if (p.hash_match === false || !p.onchain_lookup) {
          setProof({
            ...p,
            status: "OFFCHAIN_ONLY",
            status_explain:
              p.status_explain ||
              "Decision recorded locally; no NEAR receipt exists.",
          });
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
            status_explain: "Proof lookup temporarily unavailable.",
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

  const status = verifiedStatusLabel(proof);
  const govItems = (txs?.governance || []).map((g) => ({
    id: g.tx,
    title: governanceTitle(g.kind),
    hash: g.tx,
    href: g.explorer,
  }));

  return (
    <div className="page-enter nio-page-shell">
      <div className="axis-intro">
        <div>
          <h1>Proof &amp; Verify</h1>
          <p>
            Public mainnet audit trail for {identities.policy} — no wallet required.
            Audit receipt ≠ settled swap. Updated {formatLastUpdated(live.lastUpdated)}.
          </p>
        </div>
        <LiveDataChrome />
      </div>

      {loading && <p className="axis-supporting">Loading live mainnet proofs…</p>}
      {error && (
        <p className="axis-supporting">
          Live API unavailable ({error}). Governance txs below are still independently
          verifiable on Nearblocks.
        </p>
      )}

      {mandate?.ok ? (
        <div
          className="axis-stats nio-metric-row"
          style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}
        >
          <MetricCard label="Epoch" value={String(mandate.mandate_epoch ?? "—")} />
          <MetricCard
            label="Autonomy"
            value={flagLabel(mandate.autonomous_trading)}
          />
          <MetricCard
            label="Max trade (raw)"
            value={String(mandate.limits.max_trade_value ?? "—")}
          />
          <MetricCard
            label="Daily (raw)"
            value={String(mandate.limits.daily_turnover_limit ?? "—")}
          />
        </div>
      ) : null}

      <div className="nio-two-col">
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Governance transactions</h2>
            <StatusBadge tone="success">MAINNET</StatusBadge>
          </div>
          <EvidenceTimeline
            items={
              govItems.length
                ? govItems
                : [
                    {
                      id: "deploy",
                      title: "Deploy WASM",
                      hash: "7rxXmYqbDL7HyBtG2EKo4g1xHbJYptphg9jMLU7Konrf",
                      href: "https://nearblocks.io/txns/7rxXmYqbDL7HyBtG2EKo4g1xHbJYptphg9jMLU7Konrf",
                    },
                    {
                      id: "activate",
                      title: "Activate mandate",
                      hash: "6zQs6C56tdPYz5BYY9Ca2T4XusU5oavt1gDw3tdDaW93",
                      href: "https://nearblocks.io/txns/6zQs6C56tdPYz5BYY9Ca2T4XusU5oavt1gDw3tdDaW93",
                    },
                    {
                      id: "audit",
                      title: "NO_TRADE audit proof",
                      hash: "CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s",
                      href: "https://nearblocks.io/txns/CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s",
                    },
                  ]
            }
            collapsedCount={4}
          />
          <p className="axis-supporting">{txs?.supervised_canaries_note}</p>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Live mandate</h2>
            <StatusBadge tone={mandate?.paused === true ? "warn" : "success"}>
              {mandate
                ? flagLabel(mandate.paused, "PAUSED", "UNPAUSED")
                : "PENDING"}
            </StatusBadge>
          </div>
          {mandate?.ok ? (
            <p className="axis-supporting">
              Policy <span className="mono">{mandate.policy}</span> · enforce{" "}
              {flagLabel(mandate.enforce_autonomous_on_agent)}
            </p>
          ) : (
            <p className="axis-supporting">Mandate view pending live API.</p>
          )}
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("mandate")}
          >
            Open mandate
          </button>
        </section>
      </div>

      <h3>Decision cycles</h3>
      <div className="nio-decision-list">
        {decisions.length === 0 && (
          <p className="axis-supporting">
            No anchored decision records in OCI store yet. Static CXR4ey Nearblocks
            receipt remains independently verifiable under Governance.
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
        <section className="axis-panel nio-proof-detail">
          <div className="axis-panel-heading">
            <h2>Selected proof</h2>
            <Badge kind="status">{status}</Badge>
          </div>
          <p>{statusExplain(status, proof)}</p>
          <ul className="nio-kv">
            <li className="mono">
              Off-chain hash {String(proof.offchain_evidence_hash || "—").slice(0, 18)}…
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
        </section>
      )}
    </div>
  );
}
