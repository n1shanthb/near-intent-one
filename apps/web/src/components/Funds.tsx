import { useEffect, useState } from "react";
import {
  createDeposit,
  isWithdrawDeliveryEnabled,
  listBalances,
  quoteWithdraw,
  submitWithdraw,
} from "../adapters/gatei";
import { CONFIG } from "../lib/config";
import {
  RECORDED_WITHDRAW_RECEIVED,
  RECORDED_WITHDRAW_SIGNED,
  honestLifecycleFromReceipt,
} from "../lib/withdrawLifecycle";
import type {
  BalanceSlice,
  DepositIntent,
  WithdrawLifecycleStage,
  WithdrawQuote,
  WithdrawReceipt,
} from "../types/gateI";
import { WITHDRAW_LIFECYCLE_STAGES } from "../types/gateI";
import { useProductSession } from "../state/ProductSession";
import { GateIBanner } from "./GateIBanner";
import type { NavId } from "./Shell";

const CHAINS = ["near", "ethereum", "sepolia"] as const;
const ASSETS = ["NEAR", "USDC", "ETH"] as const;

function LifecycleTrack({ stage }: { stage: WithdrawLifecycleStage | null }) {
  const idx = stage ? WITHDRAW_LIFECYCLE_STAGES.indexOf(stage) : -1;
  return (
    <ol className="lifecycle">
      {WITHDRAW_LIFECYCLE_STAGES.map((s, i) => (
        <li
          key={s}
          className={
            i < idx ? "lc done" : i === idx ? "lc current" : "lc pending"
          }
        >
          {s}
        </li>
      ))}
    </ol>
  );
}

export function Funds({ onNav }: { onNav: (id: NavId) => void }) {
  const { portfolio, gateI, authMode, boundOwner } = useProductSession();
  const [balances, setBalances] = useState<BalanceSlice[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [chain, setChain] = useState<(typeof CHAINS)[number]>("sepolia");
  const [asset, setAsset] = useState<(typeof ASSETS)[number]>("USDC");
  const [deposit, setDeposit] = useState<DepositIntent | null>(null);
  const [dest, setDest] = useState("");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<WithdrawQuote | null>(null);
  const [withdraw, setWithdraw] = useState<WithdrawReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const deliveryEnabled = isWithdrawDeliveryEnabled();
  const stage = honestLifecycleFromReceipt(withdraw, deliveryEnabled);

  useEffect(() => {
    setBalances([]);
    setDeposit(null);
    setQuote(null);
    setWithdraw(null);
    setMsg(null);
  }, [portfolio?.portfolio_id, boundOwner]);

  useEffect(() => {
    if (!portfolio || gateI.status !== "available") {
      setBalances([]);
      return;
    }
    if (boundOwner && portfolio.owner_account !== boundOwner) {
      setBalances([]);
      setLoadErr("Portfolio owner does not match connected wallet — cleared.");
      return;
    }
    let cancelled = false;
    void listBalances(portfolio.portfolio_id)
      .then((b) => {
        if (!cancelled) {
          setBalances(b);
          setLoadErr(null);
        }
      })
      .catch((e) => {
        if (!cancelled)
          setLoadErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [portfolio, gateI.status, boundOwner]);

  if (!portfolio) {
    return (
      <div className="stack">
        <section className="card">
          <p>Create a personal portfolio before depositing or withdrawing.</p>
          <button type="button" onClick={() => onNav("portfolio")}>
            Portfolio onboarding
          </button>
        </section>
      </div>
    );
  }

  const requestDeposit = async () => {
    setBusy(true);
    setMsg(null);
    setDeposit(null);
    try {
      const res = await createDeposit({
        portfolio_id: portfolio.portfolio_id,
        chain,
        asset,
      });
      if ("status" in res && res.status === "blocked") {
        setMsg(res.reason);
        return;
      }
      setDeposit(res as DepositIntent);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runQuote = async () => {
    setBusy(true);
    setMsg(null);
    setQuote(null);
    setWithdraw(null);
    try {
      const q = await quoteWithdraw({
        portfolio_id: portfolio.portfolio_id,
        chain,
        asset,
        amount,
        destination: dest,
      });
      setQuote(q);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmWithdraw = async () => {
    if (!deliveryEnabled) {
      setMsg(
        "Withdrawals stay blocked in the public demo until owner delivery is proven."
      );
      setWithdraw({
        status: "blocked",
        reason: "delivery_not_proven",
      });
      return;
    }
    if (!quote?.ok || !quote.destination_valid) {
      setMsg("Quote must be ok with a valid destination before confirming.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const receipt = await submitWithdraw({
        portfolio_id: portfolio.portfolio_id,
        chain,
        asset,
        amount,
        destination: dest,
      });
      setWithdraw(receipt);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h3>Deposit / withdraw</h3>
          <span className="badge badge-warn">TESTNET</span>
        </div>
        <p className="muted">
          Portfolio <span className="mono">{portfolio.portfolio_id}</span> · owner{" "}
          <span className="mono">{portfolio.owner_account}</span> · MPC{" "}
          <span className="mono">{portfolio.intents_signer_id ?? "—"}</span>
        </p>
        <p className="muted small">
          Balances are live Gate I reads for this portfolio only. Switching wallets
          clears prior user cache.
        </p>
      </section>

      <GateIBanner action="Deposit and withdraw" />

      <section className="card">
        <h3>Balances by network & custody</h3>
        {loadErr ? <p className="warn">{loadErr}</p> : null}
        {balances.length === 0 ? (
          <p className="muted">
            No verified balances from Gate I yet (zeros or unavailable — not
            placeholders).
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Chain</th>
                <th>Asset</th>
                <th>Amount</th>
                <th>Location</th>
                <th>Verification</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b, i) => (
                <tr key={`${b.chain}-${b.asset}-${b.location}-${i}`}>
                  <td>{b.chain}</td>
                  <td>{b.asset}</td>
                  <td className="mono">{b.amount}</td>
                  <td>{b.location}</td>
                  <td>{b.verification}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {balances.every((b) => b.amount === "0") ? (
          <p className="warn">
            Funding blocked: MPC address is unfunded. Send Sepolia ETH+USDC to the
            deposit address below. Demo <span className="mono">nio-c-*</span>{" "}
            custody is never used.
          </p>
        ) : null}
      </section>

      <section className="card">
        <h3>Network & asset</h3>
        <div className="row gap wrap">
          <label>
            Chain
            <select value={chain} onChange={(e) => setChain(e.target.value as typeof chain)}>
              {CHAINS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Asset
            <select value={asset} onChange={(e) => setAsset(e.target.value as typeof asset)}>
              {ASSETS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="card">
        <h3>Deposit</h3>
        <button
          type="button"
          disabled={busy || gateI.status !== "available"}
          onClick={() => void requestDeposit()}
        >
          {busy ? "Requesting…" : "Request deposit address"}
        </button>
        {deposit ? (
          <dl className="kv dense">
            <dt>Address</dt>
            <dd className="mono">{deposit.deposit_address}</dd>
            {deposit.memo ? (
              <>
                <dt>Memo / path</dt>
                <dd className="mono">{deposit.memo}</dd>
              </>
            ) : null}
            <dt>Status</dt>
            <dd>
              <span className={`badge badge-${deposit.status === "credited" ? "pass" : "warn"}`}>
                {deposit.status}
              </span>
            </dd>
          </dl>
        ) : null}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Withdraw lifecycle</h3>
          <span className={`badge ${deliveryEnabled ? "badge-pass" : "badge-blocked"}`}>
            {deliveryEnabled ? "DELIVERY PROVEN" : "DELIVERY NOT PROVEN"}
          </span>
        </div>
        <LifecycleTrack stage={stage} />
        <p className="muted small">
          Exact stages: Requested → Authorized → Signed → Broadcast → Confirmed →
          Received. Owner wallet/Ledger must still sign each new withdraw.
        </p>
        <p className="muted small">
          Historical NEAR auth{" "}
          <a href={RECORDED_WITHDRAW_SIGNED.explorer} target="_blank" rel="noreferrer">
            {RECORDED_WITHDRAW_SIGNED.near_tx.slice(0, 14)}…
          </a>{" "}
          = Signed only. Closure PASS delivery{" "}
          <a href={RECORDED_WITHDRAW_RECEIVED.explorer} target="_blank" rel="noreferrer">
            {RECORDED_WITHDRAW_RECEIVED.sepolia_tx.slice(0, 14)}…
          </a>{" "}
          = <strong>Received</strong> ({RECORDED_WITHDRAW_RECEIVED.amount} →{" "}
          <span className="mono">{RECORDED_WITHDRAW_RECEIVED.recipient.slice(0, 10)}…</span>
          ).
        </p>
        {!deliveryEnabled ? (
          <p className="warn">
            Confirm stays disabled until owner withdrawal delivery is proven for
            this deployment.
          </p>
        ) : (
          <p className="muted small">
            Withdraw path proven (GATE_I.md). API still requires owner signature —
            no server-side software bypass.
          </p>
        )}
        <div className="form-stack">
          <label>
            Destination
            <input
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              placeholder="0x… (allowlisted)"
            />
          </label>
          <label>
            Amount
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
            />
          </label>
        </div>
        <div className="row gap wrap">
          <button
            type="button"
            disabled={busy || gateI.status !== "available" || !dest || !amount}
            onClick={() => void runQuote()}
          >
            Estimate fee / validate
          </button>
          <button
            type="button"
            disabled={
              !deliveryEnabled ||
              busy ||
              !quote?.ok ||
              !quote.destination_valid
            }
            onClick={() => void confirmWithdraw()}
          >
            {authMode === "ledger"
              ? "Confirm delivery on Ledger (owner)"
              : "Confirm delivery with wallet (owner)"}
          </button>
        </div>
        {quote ? (
          <dl className="kv dense">
            <dt>Quote ok</dt>
            <dd>{String(quote.ok)}</dd>
            <dt>Destination valid</dt>
            <dd>{String(quote.destination_valid)}</dd>
            <dt>Fee estimate</dt>
            <dd className="mono">{quote.fee_estimate ?? "—"}</dd>
            {quote.blocked_reason ? (
              <>
                <dt>Blocked</dt>
                <dd>{quote.blocked_reason}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {withdraw ? (
          <dl className="kv dense">
            <dt>API status</dt>
            <dd>
              <span className="badge badge-warn">{withdraw.status}</span>
            </dd>
            <dt>Lifecycle stage</dt>
            <dd>{stage ?? "—"}</dd>
            {withdraw.explorer_url || withdraw.tx_hash ? (
              <>
                <dt>Receipt</dt>
                <dd>
                  <a
                    href={
                      withdraw.explorer_url ??
                      `${CONFIG.nearblocks}/txns/${withdraw.tx_hash}`
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                  >
                    {(withdraw.tx_hash ?? "explorer").slice(0, 18)}…
                  </a>
                </dd>
              </>
            ) : null}
            {withdraw.reason ? (
              <>
                <dt>Detail</dt>
                <dd>{withdraw.reason}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </section>

      {msg ? (
        <section className="card alert">
          <p>{msg}</p>
        </section>
      ) : null}

      <div className="row gap wrap">
        <button type="button" className="ghost" onClick={() => onNav("policies")}>
          Next: Policy
        </button>
        <button type="button" className="ghost" onClick={() => onNav("agent")}>
          Agent
        </button>
        <button type="button" className="ghost" onClick={() => onNav("activity")}>
          Activity
        </button>
      </div>
    </div>
  );
}
