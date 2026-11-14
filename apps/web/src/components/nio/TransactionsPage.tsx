import { useMemo, useState } from "react";
import { GATE_K_FIRST_TRADE } from "../../data/gateKEvidence";
import { H3_EXECUTION } from "../../data/evidenceSnapshot";
import {
  RECORDED_TRADE_PASS,
  RECORDED_WITHDRAW_RECEIVED,
  RECORDED_WITHDRAW_SIGNED,
} from "../../lib/withdrawLifecycle";
import { CONFIG } from "../../lib/config";
import {
  formatLastUpdated,
  useWorkspace,
} from "../../state/WorkspaceContext";
import { LiveDataChrome } from "./WorkspaceSwitcher";
import type { NavId } from "./nav";

type Tab = "all" | "executed" | "blocked" | "proofs";

type TxRow = {
  id: string;
  date: string;
  gate: string;
  type: string;
  chain: string;
  sourceChain?: string;
  destChain?: string;
  reconcile?: string;
  result: string;
  tone: "success" | "warn" | "danger" | "recorded";
  href?: string;
  detail: string;
  tabs: Tab[];
  networkLabel?: "MAINNET" | "TESTNET";
  modeLabel?: "AUTONOMOUS" | "SUPERVISED" | "HISTORICAL";
};

const HISTORICAL_ROWS: TxRow[] = [
  {
    id: "gate-k",
    date: GATE_K_FIRST_TRADE.authorized_at.slice(0, 10),
    gate: "K",
    type: "AI-directed trade",
    chain: "Sepolia (testnet)",
    sourceChain: "Sepolia",
    destChain: "NEAR Intents (testnet)",
    reconcile: "Recorded · not mainnet",
    result: "Executed · override",
    tone: "warn",
    href: GATE_K_FIRST_TRADE.execution.sepolia_explorer,
    detail:
      "24.45 USDC after Fitter ECONOMIC_NOT_VIABLE and Critic REJECT — one-time operator acceptance override. Not a mainnet four-chain proof.",
    tabs: ["all", "executed", "proofs"],
    networkLabel: "TESTNET",
    modeLabel: "SUPERVISED",
  },
  {
    id: "h3",
    date: "recorded",
    gate: "H3",
    type: "Strategy settle",
    chain: "Sepolia / NEAR",
    result: "Recorded SUCCESS",
    tone: "recorded",
    href: `${CONFIG.etherscan}/tx/${H3_EXECUTION.sepoliaTx}`,
    detail: "Historical settle proof with MPC sign and reconciler.",
    tabs: ["all", "executed", "proofs"],
    networkLabel: "TESTNET",
    modeLabel: "HISTORICAL",
  },
  {
    id: "withdraw-received",
    date: "recorded",
    gate: "I",
    type: "Withdraw Received",
    chain: "Sepolia",
    result: RECORDED_WITHDRAW_RECEIVED.amount,
    tone: "success",
    href: RECORDED_WITHDRAW_RECEIVED.explorer,
    detail: "Closure PASS Sepolia withdraw delivery proof.",
    tabs: ["all", "executed", "proofs"],
    networkLabel: "TESTNET",
    modeLabel: "HISTORICAL",
  },
  {
    id: "withdraw-signed",
    date: "recorded",
    gate: "F",
    type: "Withdraw Signed",
    chain: "NEAR",
    result: "Signed only",
    tone: "recorded",
    href: RECORDED_WITHDRAW_SIGNED.explorer,
    detail: "Early NEAR authorization — not Broadcast/Confirmed/Received alone.",
    tabs: ["all", "proofs"],
    networkLabel: "TESTNET",
    modeLabel: "HISTORICAL",
  },
  {
    id: "trade-pass",
    date: "recorded",
    gate: "I",
    type: "Trade PASS",
    chain: "Sepolia",
    result: "Tidepool SUCCESS",
    tone: "success",
    href: RECORDED_TRADE_PASS.explorer,
    detail: "Recorded trade proof distinct from Gate K override execution.",
    tabs: ["all", "executed", "proofs"],
    networkLabel: "TESTNET",
    modeLabel: "HISTORICAL",
  },
];

export function TransactionsPage({ onNav }: { onNav: (id: NavId) => void }) {
  const { isPublic, live, personalProvisioned } = useWorkspace();
  const [tab, setTab] = useState<Tab>("all");
  const [selected, setSelected] = useState<string | null>(null);

  const mainnetRows: TxRow[] = useMemo(() => {
    if (!isPublic) return [];
    const gov = (live.transactions?.governance || []).map((g) => ({
      id: `gov-${g.tx}`,
      date: "mainnet",
      gate: "GOV",
      type: g.kind,
      chain: "NEAR mainnet",
      result: g.label,
      tone: "success" as const,
      href: g.explorer,
      detail: `Governance / policy transaction on NEAR mainnet.`,
      tabs: ["all", "proofs"] as Tab[],
      networkLabel: "MAINNET" as const,
      modeLabel: "AUTONOMOUS" as const,
    }));
    const decisions = live.decisions.map((d) => ({
      id: d.cycle_id,
      date: new Date(d.timestamp_ms).toISOString().slice(0, 19),
      gate: "AUDIT",
      type:
        d.final_action === "NO_TRADE"
          ? "Decision audit · NO_TRADE"
          : `Decision audit · ${d.final_action}`,
      chain: "NEAR mainnet",
      result: `${d.status} · Fitter ${d.fitter_verdict}`,
      tone:
        d.final_action === "NO_TRADE"
          ? ("danger" as const)
          : ("success" as const),
      href: d.explorer ?? undefined,
      detail: `${d.reason_code} · epoch ${d.mandate_epoch} · evidence ${d.evidence_hash.slice(0, 16)}… · Critic ${d.critic_verdict}. Audit receipt ≠ settled swap.`,
      tabs: (
        d.final_action === "NO_TRADE"
          ? ["all", "blocked", "proofs"]
          : ["all", "executed", "proofs"]
      ) as Tab[],
      networkLabel: "MAINNET" as const,
      modeLabel: "AUTONOMOUS" as const,
    }));
    return [...decisions, ...gov];
  }, [isPublic, live.decisions, live.transactions]);

  const allRows = isPublic
    ? [...mainnetRows, ...HISTORICAL_ROWS.map((r) => ({ ...r, tabs: [...r.tabs, "proofs"] as Tab[] }))]
    : HISTORICAL_ROWS;

  const rows = useMemo(
    () => allRows.filter((r) => r.tabs.includes(tab)),
    [allRows, tab]
  );
  const active =
    allRows.find((r) => r.id === selected) ??
    rows[0] ??
    null;

  return (
    <div className="page-enter nio-tx-page">
      <div className="axis-intro">
        <div>
          <h1>Transactions</h1>
          <p>
            {isPublic
              ? "Live autonomous decision audits and governance txs on NEAR mainnet. Historical testnet proofs stay clearly labeled."
              : personalProvisioned
                ? "Personal activity when provisioned. Historical testnet proofs remain separate."
                : "Personal workspace not provisioned — showing labeled historical evidence only."}
          </p>
        </div>
        {isPublic ? <LiveDataChrome /> : null}
      </div>

      <div className="axis-segmented" role="tablist" aria-label="Activity filters">
        {(
          [
            ["all", "All Activity"],
            ["executed", "Executed"],
            ["blocked", "Blocked / Rejected"],
            ["proofs", "Historical Proofs"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {isPublic && live.status === "error" ? (
        <p className="axis-supporting" role="alert">
          Live mainnet activity API error: {live.error}. Historical rows below
          remain independently labeled TESTNET.
        </p>
      ) : null}
      {isPublic ? (
        <p className="axis-supporting">
          Updated {formatLastUpdated(live.lastUpdated)} · polling while visible
        </p>
      ) : null}

      <div className="nio-tx-layout">
        <section className="axis-panel">
          <div className="axis-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Network</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    data-selected={active?.id === r.id ? "1" : "0"}
                    onClick={() => setSelected(r.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <td className="mono">{r.date}</td>
                    <td>{r.type}</td>
                    <td>
                      <span
                        className={`nio-badge ${
                          r.networkLabel === "MAINNET"
                            ? "nio-badge-success"
                            : "nio-badge-recorded"
                        }`}
                      >
                        {r.networkLabel ?? "TESTNET"}
                      </span>{" "}
                      {r.modeLabel ? (
                        <span className="nio-badge nio-badge-idle">
                          {r.modeLabel}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span className={`nio-badge nio-badge-${r.tone}`}>
                        {r.result}
                      </span>
                    </td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td colSpan={4} className="axis-supporting">
                      No rows for this filter.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Detail</h2>
            {active?.networkLabel ? (
              <span
                className={`nio-badge ${
                  active.networkLabel === "MAINNET"
                    ? "nio-badge-success"
                    : "nio-badge-recorded"
                }`}
              >
                {active.networkLabel}
              </span>
            ) : null}
          </div>
          {active ? (
            <>
              <p>{active.detail}</p>
              <p className="axis-supporting mono">
                {active.chain}
                {active.sourceChain
                  ? ` · ${active.sourceChain} → ${active.destChain}`
                  : ""}
              </p>
              {active.href ? (
                <a
                  className="axis-button secondary"
                  href={active.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open explorer
                </a>
              ) : null}
              {active.networkLabel === "TESTNET" ? (
                <p className="axis-supporting" style={{ marginTop: 10 }}>
                  Labeled historical testnet evidence — not mainnet settlement.
                </p>
              ) : null}
            </>
          ) : (
            <p className="axis-supporting">Select a row.</p>
          )}
          <div className="axis-actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="axis-button secondary"
              onClick={() => onNav("verify")}
            >
              Proof &amp; Verify
            </button>
            <button
              type="button"
              className="axis-button secondary"
              onClick={() => onNav("evidence")}
            >
              Historical evidence
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
