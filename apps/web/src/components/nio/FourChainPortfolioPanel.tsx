import {
  NIO_CHAINS,
  emptyFourChainPositions,
  chainLabel,
  VERIFIED_TOKEN_OPTIONS,
} from "../../lib/chains";

/**
 * Honest four-chain portfolio panel — balances null until verified live reads.
 */
export function FourChainPortfolioPanel() {
  const positions = emptyFourChainPositions();
  const combinedUsd = positions.every((p) => p.usd == null)
    ? null
    : positions.reduce((s, p) => s + (p.usd || 0), 0);

  return (
    <section className="axis-panel">
      <div className="axis-panel-heading">
        <h2>Four-chain portfolio</h2>
        <span className="nio-badge nio-badge-warn">UNVERIFIED BALANCES</span>
      </div>
      <p className="axis-supporting">
        Four-chain ambition across NEAR, Arbitrum, Base, and Ethereum. Identities
        are canonical; funded execution adapters for same-chain EVM and NEAR DEX
        remain unsupported. Combined USD appears only from verified price sources —
        never placeholders. Mainnet deposits are not enabled — do not send funds.
      </p>

      <div
        className="axis-stats"
        style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}
      >
        {NIO_CHAINS.map((c) => (
          <div className="axis-stat" key={c.id}>
            <span>{c.short}</span>
            <strong style={{ fontSize: 16 }}>
              {c.status === "verified" ? "Verified" : "Awaiting"}
            </strong>
            <small className="mono">{c.id}</small>
          </div>
        ))}
        <div className="axis-stat">
          <span>Combined USD</span>
          <strong style={{ fontSize: 16 }}>
            {combinedUsd == null ? "—" : `$${combinedUsd.toFixed(2)}`}
          </strong>
          <small>no fake quotes</small>
        </div>
      </div>

      <div className="nio-table-wrap" style={{ marginTop: 16 }}>
        <table className="nio-table">
          <thead>
            <tr>
              <th>Chain</th>
              <th>Asset id</th>
              <th>Symbol</th>
              <th>Balance</th>
              <th>Gas</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={`${p.chain}-${p.asset_id}`}>
                <td>{chainLabel(p.chain)}</td>
                <td className="mono" style={{ fontSize: 11 }}>
                  {p.asset_id}
                </td>
                <td>{p.symbol}</td>
                <td>{p.balance ?? "— not read —"}</td>
                <td>{p.gas_reserve ? "reserve" : "—"}</td>
                <td>{p.risk_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>
          Network-aware asset selector (verified identities)
        </h3>
        <select className="axis-input" disabled title="Owner session required">
          <option value="">Select asset (owner signing required)…</option>
          {VERIFIED_TOKEN_OPTIONS.map((t) => (
            <option key={t.asset_id} value={t.asset_id}>
              {t.symbol} · {t.chain}
            </option>
          ))}
        </select>
        <p className="axis-supporting">
          Selector lists canonical ids only. Owner-only signing and withdrawals
          stay locked on the public demo BFF.
        </p>
      </div>
    </section>
  );
}
