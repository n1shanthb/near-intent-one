import { useMemo, useState } from "react";
import { compilePolicyFromText } from "../policy/compile";
import { policyDiff } from "../policy/diff";
import { policyPreviewHash } from "../policy/hash";
import { CONSTRAINT_META, KNOWN_ASSETS } from "../policy/schema";
import { FROZEN_POLICY } from "../data/evidenceSnapshot";
import { gateFLedger } from "../adapters/gatef";
import { useProductSession } from "../state/ProductSession";
import { GateIBanner } from "./GateIBanner";

const EXAMPLE =
  "Allow trading on Ethereum and NEAR, only USDC, ETH and NEAR. Maximum $10 per trade, $50 per day, 1% slippage and stop at 5% drawdown.";

export function Policies({ onOpenLedger }: { onOpenLedger?: () => void }) {
  const { authMode, portfolio, gateI } = useProductSession();
  const [text, setText] = useState(EXAMPLE);
  const [chains, setChains] = useState({ ethereum: true, near: true });
  const [tokens, setTokens] = useState({ USDC: true, ETH: true, NEAR: true });
  const [hash, setHash] = useState<string | null>(null);
  const [handoffMsg, setHandoffMsg] = useState<string | null>(null);
  const isLedger = authMode === "ledger";

  const composed = useMemo(() => {
    const chainBits = [
      chains.ethereum ? "Ethereum" : null,
      chains.near ? "NEAR" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    const tokBits = Object.entries(tokens)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ");
    // Prefer free-text; selectors nudge the example string when user clicks Apply selectors
    return text.includes("Allow trading")
      ? text
      : `Allow trading on ${chainBits || "NEAR"}, only ${tokBits || "USDC"}. ${text}`;
  }, [text, chains, tokens]);

  const result = useMemo(() => compilePolicyFromText(composed), [composed]);
  const diffs = result.ok
    ? policyDiff(
        {
          max_trade_value: FROZEN_POLICY.max_trade_value,
          daily_turnover_limit: FROZEN_POLICY.daily_turnover_limit,
          max_pending_exposure: FROZEN_POLICY.max_pending_exposure,
          max_slippage_bps: FROZEN_POLICY.max_slippage_bps,
          allowed_assets: FROZEN_POLICY.allowed_assets,
          allowed_destinations: FROZEN_POLICY.allowed_destinations,
          valid_until: FROZEN_POLICY.valid_until,
        },
        result.policy
      )
    : [];

  return (
    <div className="policies">
      <section className="card" style={{ gridColumn: "1 / -1" }}>
        <GateIBanner action="Personal portfolio policy deploy" />
        <dl className="kv dense">
          <dt>Target</dt>
          <dd className="mono">
            {portfolio?.policy_contract ??
              "No personal portfolio — compiler preview only (demo frozen policy)"}
          </dd>
          <dt>Auth mode</dt>
          <dd>
            {authMode ?? "unset"} ·{" "}
            {isLedger
              ? "owner writes require physical Ledger"
              : "ordinary wallet — no Ledger approval UI"}
          </dd>
          <dt>Gate I</dt>
          <dd>{gateI.status}</dd>
        </dl>
      </section>
      <section className="card grow">
        <div className="card-head">
          <h3>Typed policy compiler</h3>
          <span className="badge badge-warn">NOT AN LLM</span>
        </div>
        <p className="muted">
          Deterministic natural-language → Zod schema builder. Ambiguous requests
          are rejected. Preview shows precisely what the contract would enforce.
          Confirmation uses the connected owner path — Ledger only when auth mode
          is hardware.
        </p>

        <div className="selector-grid">
          <fieldset>
            <legend>Chains</legend>
            {(["ethereum", "near"] as const).map((c) => (
              <label key={c} className="check">
                <input
                  type="checkbox"
                  checked={chains[c]}
                  onChange={(e) =>
                    setChains((s) => ({ ...s, [c]: e.target.checked }))
                  }
                />
                {c}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Tokens</legend>
            {(["USDC", "ETH", "NEAR"] as const).map((t) => (
              <label key={t} className="check">
                <input
                  type="checkbox"
                  checked={tokens[t]}
                  onChange={(e) =>
                    setTokens((s) => ({ ...s, [t]: e.target.checked }))
                  }
                />
                {t}
              </label>
            ))}
          </fieldset>
        </div>

        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHash(null);
            setHandoffMsg(null);
          }}
          rows={5}
        />
        <div className="row">
          <button type="button" onClick={() => setText(EXAMPLE)}>
            Load example
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              const chainBits = [
                chains.ethereum ? "Ethereum" : null,
                chains.near ? "NEAR" : null,
              ]
                .filter(Boolean)
                .join(" and ");
              const tokBits = Object.entries(tokens)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .join(", ");
              setText(
                `Allow trading on ${chainBits}, only ${tokBits}. Maximum $10 per trade, $50 per day, 1% slippage and stop at 5% drawdown.`
              );
            }}
          >
            Apply selectors
          </button>
        </div>

        {!result.ok && (
          <ul className="issues">
            {result.issues.map((i) => (
              <li key={i.message}>{i.message}</li>
            ))}
          </ul>
        )}
        {result.ok && (
          <div className="policy-cards">
            {result.explanation.map((e) => (
              <div key={e} className="policy-card">
                {e}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card grow">
        <h3>Structured preview & risk</h3>
        {result.ok ? (
          <>
            <div className="constraint-split">
              <div>
                <h4>Contract-enforced</h4>
                <ul>
                  {Object.entries(CONSTRAINT_META)
                    .filter(([, m]) => m.class === "enforced")
                    .map(([k, m]) => (
                      <li key={k}>
                        <code>{k}</code> — {m.note}
                      </li>
                    ))}
                </ul>
              </div>
              <div>
                <h4>Planned (not on-chain)</h4>
                <ul>
                  {Object.entries(CONSTRAINT_META)
                    .filter(([, m]) => m.class === "planned")
                    .map(([k, m]) => (
                      <li key={k}>
                        <code>{k}</code> — {m.note}
                      </li>
                    ))}
                </ul>
              </div>
            </div>
            <p className="muted small">
              Known asset map includes{" "}
              <span className="mono">{KNOWN_ASSETS.USDC_SEPOLIA_OMFT}</span>
            </p>
            <pre className="code">{JSON.stringify(result.onChainPayload, null, 2)}</pre>
            <h4>Diff vs frozen Gate F4 policy</h4>
            <table className="diff">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Before</th>
                  <th>After</th>
                  <th>Class</th>
                </tr>
              </thead>
              <tbody>
                {diffs.length === 0 ? (
                  <tr>
                    <td colSpan={4}>No differences</td>
                  </tr>
                ) : (
                  diffs.map((d) => (
                    <tr key={d.field}>
                      <td>{d.field}</td>
                      <td className="mono">{d.before}</td>
                      <td className="mono">{d.after}</td>
                      <td>
                        <span className={`badge badge-${d.constraintClass}`}>
                          {d.constraintClass}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div className="row gap wrap">
              <button
                type="button"
                className="ghost"
                onClick={async () => {
                  setHash(await policyPreviewHash(result.onChainPayload));
                }}
              >
                Preview hash
              </button>
              {isLedger ? (
                <button
                  type="button"
                  onClick={async () => {
                    const prep = await gateFLedger.prepareOwnerCall({
                      method: "set_policy",
                      args: result.onChainPayload,
                    });
                    setHandoffMsg(
                      prep.status === "ready_for_ledger"
                        ? prep.summary
                        : prep.reason
                    );
                    if (prep.status === "ready_for_ledger") onOpenLedger?.();
                  }}
                >
                  Confirm on Ledger
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!portfolio || gateI.status !== "available"}
                  onClick={() => {
                    setHandoffMsg(
                      !portfolio
                        ? "Create a personal portfolio first."
                        : gateI.status !== "available"
                          ? "Live API unreachable — set_policy blocked (no fake success)."
                          : "Personal portfolio management requires an authenticated owner session and is unavailable in public demo mode."
                    );
                  }}
                >
                  Confirm with connected wallet
                </button>
              )}
            </div>
            {hash && <p className="mono small">sha256 {hash}</p>}
            {handoffMsg && <p className="warn">{handoffMsg}</p>}
            <p className="muted small">
              Status: <strong>PROPOSED — NOT APPROVED</strong> until the authorized
              owner path confirms.{" "}
              {isLedger
                ? "Hardware users see Ledger prompts only."
                : "Ordinary wallets never show a misleading Ledger approval state."}
            </p>
          </>
        ) : (
          <p className="muted">Fix compiler errors to preview policy JSON.</p>
        )}
      </section>
    </div>
  );
}
