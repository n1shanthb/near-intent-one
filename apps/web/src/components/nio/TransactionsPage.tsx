import { useMemo, useState } from "react";
import { GATE_K_FIRST_TRADE } from "../../data/gateKEvidence";
import { H3_EXECUTION } from "../../data/evidenceSnapshot";
import {
  RECORDED_TRADE_PASS,
  RECORDED_WITHDRAW_RECEIVED,
  RECORDED_WITHDRAW_SIGNED,
} from "../../lib/withdrawLifecycle";
import { CONFIG } from "../../lib/config";
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
};

const ROWS: TxRow[] = [
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
  },
  {
    id: "dry-run",
    date: "live",
    gate: "J",
    type: "Live AI dry-run",
    chain: "Off-chain",
    result: "NO_TRADE / BLOCKED",
    tone: "danger",
    detail: "Public demo-decide never signs. Typical outcome: Strategist NO_TRADE or Critic veto.",
    tabs: ["all", "blocked"],
  },
];

export function TransactionsPage({ onNav }: { onNav: (id: NavId) => void }) {
  const [tab, setTab] = useState<Tab>("all");
  const [selected, setSelected] = useState<string | null>("gate-k");

  const rows = useMemo(
    () => ROWS.filter((r) => r.tabs.includes(tab)),
    [tab]
  );
  const active = ROWS.find((r) => r.id === selected) ?? rows[0] ?? null;

  return (
    <div className="page-enter nio-tx-page">
      <div className="axis-intro">
        <div>
          <h1>Transactions</h1>
          <p>Compact activity across gates. Historical proofs stay collapsed until selected.</p>
        </div>
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

      <div className="nio-tx-layout">
        <section className="axis-panel">
          <div className="axis-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Gate</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Dest</th>
                  <th>Reconcile</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className={selected === r.id ? "nio-row-selected" : undefined}
                    onClick={() => setSelected(r.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <td className="mono">{r.date}</td>
                    <td>{r.gate}</td>
                    <td>{r.type}</td>
                    <td>{r.sourceChain ?? r.chain}</td>
                    <td>{r.destChain ?? "—"}</td>
                    <td>{r.reconcile ?? "—"}</td>
                    <td>
                      <span className={`nio-badge nio-badge-${r.tone === "recorded" ? "recorded" : r.tone}`}>
                        {r.result}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Detail</h2>
            {active ? (
              <span className={`nio-badge nio-badge-${active.tone === "recorded" ? "recorded" : active.tone}`}>
                Gate {active.gate}
              </span>
            ) : null}
          </div>
          {active ? (
            <>
              <p>
                <strong>{active.type}</strong> · {active.chain}
              </p>
              <p className="axis-supporting">{active.detail}</p>
              <div className="axis-actions" style={{ marginTop: 12 }}>
                {active.href ? (
                  <a className="axis-button secondary" href={active.href} target="_blank" rel="noreferrer">
                    Open explorer
                  </a>
                ) : null}
                {active.id === "gate-k" ? (
                  <button type="button" className="axis-button" onClick={() => onNav("evidence")}>
                    Full Gate K evidence
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <div className="nio-empty-state">
              <p>Select a row to inspect evidence.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
