import { useMemo, useState } from "react";
import { compilePolicyFromText } from "../../policy/compile";
import { CONSTRAINT_META } from "../../policy/schema";
import { FROZEN_POLICY } from "../../data/evidenceSnapshot";
import { useProductSession } from "../../state/ProductSession";
import type { NavId } from "./nav";

const EXAMPLE =
  "Allow trading on Ethereum and NEAR, only USDC, ETH and NEAR. Maximum $10 per trade, $50 per day, 1% slippage and stop at 5% drawdown.";

const DISPLAY_ASSETS = ["USDC", "ETH", "NEAR"] as const;

type Tab = "overview" | "composer" | "preview";

export function MandatePage({ onNav }: { onNav: (id: NavId) => void }) {
  const { authMode, portfolio, gateI } = useProductSession();
  const [tab, setTab] = useState<Tab>("overview");
  const [text, setText] = useState(EXAMPLE);
  const [chains, setChains] = useState({ ethereum: true, near: true });
  const [tokens, setTokens] = useState<Record<(typeof DISPLAY_ASSETS)[number], boolean>>({
    USDC: true,
    ETH: true,
    NEAR: true,
  });
  const [showJson, setShowJson] = useState(false);

  const composed = useMemo(() => {
    const chainBits = [
      chains.ethereum ? "Ethereum" : null,
      chains.near ? "NEAR" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    const tokBits = DISPLAY_ASSETS.filter((k) => tokens[k]).join(", ");
    return text.includes("Allow trading")
      ? text
      : `Allow trading on ${chainBits || "NEAR"}, only ${tokBits || "USDC"}. ${text}`;
  }, [text, chains, tokens]);

  const result = useMemo(() => compilePolicyFromText(composed), [composed]);

  const rules = result.ok
    ? [
        {
          rule: "Max trade value",
          value: String(result.policy.max_trade_value ?? "—"),
          status: "Compiler enforced",
        },
        {
          rule: "Daily turnover",
          value: String(result.policy.daily_turnover_limit ?? "—"),
          status: "Compiler enforced",
        },
        {
          rule: "Allowed assets",
          value: (result.policy.allowed_assets ?? []).join(", ") || "—",
          status: "Contract enforced (when deployed)",
        },
        {
          rule: "Max slippage (bps)",
          value: String(result.policy.max_slippage_bps ?? "—"),
          status: "Planned / unsupported on-chain",
        },
      ]
    : [];

  return (
    <div className="page-enter nio-mandate-page">
      <div className="axis-intro">
        <div>
          <h1>Mandate</h1>
          <p>
            Policy overview, natural-language compiler, and structured preview.
            Owner mutations stay blocked without authorization.
          </p>
        </div>
      </div>

      <div className="axis-segmented" role="tablist">
        {(
          [
            ["overview", "Policy overview"],
            ["composer", "Composer"],
            ["preview", "Preview & verify"],
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

      {tab === "overview" ? (
        <section className="axis-panel" style={{ marginTop: 16 }}>
          <div className="axis-panel-heading">
            <h2>Current policy posture</h2>
            <span className="nio-badge nio-badge-recorded">DEMO / PREVIEW</span>
          </div>
          <dl className="nio-kv">
            <div>
              <dt>API</dt>
              <dd>{gateI.status === "available" ? "Connected" : "Recorded / unreachable"}</dd>
            </div>
            <div>
              <dt>Auth mode</dt>
              <dd>{authMode ?? "unset (public visitor)"}</dd>
            </div>
            <div>
              <dt>Personal policy contract</dt>
              <dd className="mono">
                {portfolio?.policy_contract ?? "None — compiler preview only"}
              </dd>
            </div>
            <div>
              <dt>Frozen demo max trade</dt>
              <dd className="mono">{FROZEN_POLICY.max_trade_value}</dd>
            </div>
          </dl>
          <p className="axis-supporting" style={{ marginTop: 12 }}>
            Public visitors can inspect rules. Deploying or mutating a personal mandate
            requires an authenticated owner session and is unavailable in public demo mode.
          </p>
          <button type="button" className="axis-button secondary" onClick={() => onNav("security")}>
            Open security / Ledger
          </button>
        </section>
      ) : null}

      {tab === "composer" ? (
        <section className="axis-panel" style={{ marginTop: 16 }}>
          <div className="axis-panel-heading">
            <h2>Mandate composer</h2>
            <span className="nio-badge nio-badge-warn">NOT AN LLM</span>
          </div>
          <div className="nio-form-grid">
            <label className="axis-field">
              <span>Chains</span>
              <div className="nio-check-row">
                {(["ethereum", "near"] as const).map((c) => (
                  <label key={c}>
                    <input
                      type="checkbox"
                      checked={chains[c]}
                      onChange={(e) =>
                        setChains((prev) => ({ ...prev, [c]: e.target.checked }))
                      }
                    />
                    {c}
                  </label>
                ))}
              </div>
            </label>
            <label className="axis-field">
              <span>Assets</span>
              <div className="nio-check-row">
                {DISPLAY_ASSETS.map((a) => (
                  <label key={a}>
                    <input
                      type="checkbox"
                      checked={tokens[a]}
                      onChange={(e) =>
                        setTokens((prev) => ({ ...prev, [a]: e.target.checked }))
                      }
                    />
                    {a}
                  </label>
                ))}
              </div>
            </label>
          </div>
          <label className="axis-field" style={{ marginTop: 12 }}>
            <span>Natural-language instruction</span>
            <textarea
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="axis-actions" style={{ marginTop: 12 }}>
            <button type="button" className="axis-button secondary" onClick={() => setText(EXAMPLE)}>
              Load example
            </button>
            <button type="button" className="axis-button" onClick={() => setTab("preview")}>
              Compile / preview
            </button>
          </div>
        </section>
      ) : null}

      {tab === "preview" ? (
        <section className="axis-panel" style={{ marginTop: 16 }}>
          <div className="axis-panel-heading">
            <h2>Structured preview</h2>
            <span className={`nio-badge ${result.ok ? "nio-badge-success" : "nio-badge-danger"}`}>
              {result.ok ? "Compiled" : "Compile error"}
            </span>
          </div>
          {!result.ok ? (
            <div className="nio-disclosure">
              {result.issues.map((i) => i.message).join(" · ")}
            </div>
          ) : (
            <>
              <div className="axis-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Rule</th>
                      <th>Value</th>
                      <th>Enforcement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((r) => (
                      <tr key={r.rule}>
                        <td>{r.rule}</td>
                        <td className="mono">{r.value}</td>
                        <td>{r.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="axis-supporting" style={{ marginTop: 12 }}>
                Constraint catalog covers {Object.keys(CONSTRAINT_META).length} known fields.
                Planned features are labeled honestly and are not claimed as on-chain enforced.
              </p>
              <button
                type="button"
                className="axis-button secondary"
                onClick={() => setShowJson((v) => !v)}
              >
                {showJson ? "Hide raw JSON" : "Show raw JSON"}
              </button>
              {showJson ? (
                <pre className="nio-code-block mono">
                  {JSON.stringify(result.policy, null, 2)}
                </pre>
              ) : null}
              <p className="axis-supporting" style={{ marginTop: 12 }}>
                Owner set_policy remains blocked without an authenticated owner session.
              </p>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
