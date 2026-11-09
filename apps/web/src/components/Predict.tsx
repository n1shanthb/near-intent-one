import { useMemo, useState } from "react";
import { compilePolicyFromText } from "../policy/compile";
import { comparePolicies, runPredict } from "../predict/engine";
import { packForHorizon } from "../predict/scenarios";
import type { Horizon, PredictResult } from "../predict/types";

const POLICY_A =
  "Allow trading on Ethereum and NEAR, only USDC and NEAR. Maximum $10 per trade, $50 per day, 1% slippage and stop at 5% drawdown.";
const POLICY_B =
  "Allow trading on Ethereum and NEAR, only USDC and NEAR. Maximum $5 per trade, $20 per day, 0.5% slippage and stop at 3% drawdown.";

export function PredictView() {
  const [horizon, setHorizon] = useState<Horizon>("30d");
  const [textA, setTextA] = useState(POLICY_A);
  const [textB, setTextB] = useState(POLICY_B);

  const compiledA = useMemo(() => compilePolicyFromText(textA), [textA]);
  const compiledB = useMemo(() => compilePolicyFromText(textB), [textB]);

  const comparison = useMemo(() => {
    if (!compiledA.ok || !compiledB.ok) return null;
    return comparePolicies({
      policyA: compiledA.policy,
      policyB: compiledB.policy,
      labelA: "Policy A",
      labelB: "Policy B",
      horizon,
      pack: packForHorizon(horizon),
    });
  }, [compiledA, compiledB, horizon]);

  const single = useMemo(() => {
    if (!compiledA.ok) return null;
    return runPredict(compiledA.policy, horizon, "Policy A");
  }, [compiledA, horizon]);

  return (
    <div className="stack">
      <section className="card alert">
        <h3>Predict — illustrative simulation</h3>
        <p className="warn">
          ILLUSTRATIVE · NOT VERIFIED MARKET HISTORY · NOT GATE EVIDENCE. Synthetic
          deterministic mid series. Do not read P/L as live or historical strategy
          performance.
        </p>
        <div className="row">
          <label>
            Horizon{" "}
            <select
              value={horizon}
              onChange={(e) => setHorizon(e.target.value as Horizon)}
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </label>
        </div>
        <div className="policies">
          <label className="card flat">
            Policy A
            <textarea value={textA} onChange={(e) => setTextA(e.target.value)} rows={4} />
          </label>
          <label className="card flat">
            Policy B
            <textarea value={textB} onChange={(e) => setTextB(e.target.value)} rows={4} />
          </label>
        </div>
      </section>

      {comparison && single && (
        <>
          <div className="cards-3">
            <article className="card">
              <p className="muted small">A illustrative PnL</p>
              <strong className="metric-value">
                ${comparison.a.simulatedPnlUsd}
              </strong>
              <span className="badge badge-warn">ILLUSTRATIVE</span>
            </article>
            <article className="card">
              <p className="muted small">B illustrative PnL</p>
              <strong className="metric-value">
                ${comparison.b.simulatedPnlUsd}
              </strong>
              <span className="badge badge-warn">ILLUSTRATIVE</span>
            </article>
            <article className="card">
              <p className="muted small">A max drawdown</p>
              <strong className="metric-value">
                {comparison.a.maxDrawdownPct}%
              </strong>
            </article>
          </div>

          <section className="card">
            <h4>Exposure / equity sketch (Policy A)</h4>
            <EquityChart result={comparison.a} />
            <p className="muted small">{single.provenance}</p>
          </section>

          <section className="card">
            <h4>A/B comparison</h4>
            <table className="diff">
              <thead>
                <tr>
                  <th></th>
                  <th>A</th>
                  <th>B</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Permitted / rejected</td>
                  <td>
                    {comparison.a.permittedCount} / {comparison.a.rejectedCount}
                  </td>
                  <td>
                    {comparison.b.permittedCount} / {comparison.b.rejectedCount}
                  </td>
                </tr>
                <tr>
                  <td>Turnover</td>
                  <td>${comparison.a.turnoverUsd}</td>
                  <td>${comparison.b.turnoverUsd}</td>
                </tr>
                <tr>
                  <td>Costs</td>
                  <td>${comparison.a.costsUsd}</td>
                  <td>${comparison.b.costsUsd}</td>
                </tr>
              </tbody>
            </table>
            <h4>Why trades were rejected (A sample)</h4>
            <ul>
              {comparison.a.trades
                .filter((t) => !t.permitted)
                .slice(0, 6)
                .map((t, i) => (
                  <li key={`${t.t}-${i}`}>
                    {t.t} · ${t.sizeUsd} · {t.rejectReason}
                  </li>
                ))}
            </ul>
            <h4>Suggestions</h4>
            <ul>
              {comparison.a.suggestions.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </section>
        </>
      )}

      {(!compiledA.ok || !compiledB.ok) && (
        <p className="err">Both policies must compile to run Predict.</p>
      )}
    </div>
  );
}

function EquityChart({ result }: { result: PredictResult }) {
  let equity = 100;
  const points: number[] = [equity];
  for (const t of result.trades) {
    if (t.permitted) equity += t.pnlUsd;
    points.push(equity);
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const w = 640;
  const h = 140;
  const path = points
    .map((y, i) => {
      const x = (i / Math.max(points.length - 1, 1)) * (w - 20) + 10;
      const ny = h - 10 - ((y - min) / Math.max(max - min, 1e-6)) * (h - 20);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ny.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart" role="img" aria-label="Illustrative equity">
      <rect width={w} height={h} fill="transparent" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" />
    </svg>
  );
}
