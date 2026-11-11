import { useEffect, useState } from "react";
import { Usb, KeyRound, ShieldCheck, LogOut, MonitorOff } from "lucide-react";
import {
  authenticateOwnerWithLedger,
  classifyOwnerError,
  connectLedgerForOwner,
  ensureOwnerCsrf,
} from "../../adapters/ownerAuth";
import {
  DEFAULT_DERIVATION_PATH,
  isLedgerSupported,
} from "../../ledger/ledgerClient";
import {
  abbreviateKey,
  useOwnerSession,
} from "../../state/OwnerSession";
import type { NavId } from "./nav";

type Step =
  | "idle"
  | "connecting"
  | "select_account"
  | "challenging"
  | "await_device"
  | "verifying"
  | "done"
  | "error";

/** Preview cards for judges — never mark as a real authenticated session. */
const STATE_PREVIEW = [
  { label: "Ledger not connected", detail: "Default until WebHID Connect succeeds." },
  { label: "WebHID unsupported", detail: "Shown on Safari / mobile browsers." },
  { label: "NEAR app not open", detail: "Recovery: unlock → open NEAR app → reconnect." },
  { label: "FullAccess missing", detail: "FunctionCall-limited keys are rejected." },
  { label: "Signature rejected", detail: "Device reject ≠ authenticated session." },
  { label: "Awaiting provisioning", detail: "My Portfolio waits honestly after verify." },
] as const;

export function OwnerAuthPage({ onNav }: { onNav: (id: NavId) => void }) {
  const {
    session,
    verified,
    refreshing,
    device,
    ledgerClient,
    setLedgerClient,
    setDevice,
    refreshSession,
    clearOwner,
  } = useOwnerSession();

  const [step, setStep] = useState<Step>(verified ? "done" : "idle");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorMeta, setErrorMeta] = useState<ReturnType<typeof classifyOwnerError> | null>(
    null
  );
  const [manualAccount, setManualAccount] = useState("");
  const [path, setPath] = useState(DEFAULT_DERIVATION_PATH);
  const [busy, setBusy] = useState(false);
  const webhidOk = isLedgerSupported();

  useEffect(() => {
    void ensureOwnerCsrf();
  }, []);

  useEffect(() => {
    if (verified) setStep("done");
  }, [verified]);

  const setFailure = (raw: string) => {
    const meta = classifyOwnerError(raw);
    setErrorMeta(meta);
    setError(raw);
    setStep("error");
  };

  const connect = async () => {
    if (!webhidOk) {
      setFailure("WebHID unsupported — use Chrome or Edge on desktop.");
      return;
    }
    setBusy(true);
    setError(null);
    setErrorMeta(null);
    setPrompt(null);
    setStep("connecting");
    try {
      if (ledgerClient) {
        await ledgerClient.disconnect().catch(() => undefined);
        setLedgerClient(null);
      }
      const result = await connectLedgerForOwner(path.trim() || DEFAULT_DERIVATION_PATH);
      setLedgerClient(result.client);
      setDevice({
        connected: true,
        appVersion: result.appVersion,
        publicKey: result.publicKey,
        derivationPath: result.derivationPath,
        accounts: result.accounts,
        selectedAccount: result.accounts[0] ?? (manualAccount.trim() || null),
      });
      setStep("select_account");
      setPrompt(
        result.accounts.length
          ? `Found ${result.accounts.length} NEAR account(s) for this FullAccess key.`
          : "No account auto-discovered for this key — enter the NEAR account that holds this FullAccess key."
      );
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const verifyOwnership = async () => {
    const account =
      device.selectedAccount?.trim() || manualAccount.trim() || "";
    if (!ledgerClient || !device.publicKey || !device.derivationPath) {
      setFailure("Connect Ledger first.");
      return;
    }
    if (!account) {
      setFailure("Select or enter a NEAR account.");
      return;
    }
    setBusy(true);
    setError(null);
    setErrorMeta(null);
    setDevice({ selectedAccount: account });
    try {
      setStep("challenging");
      const sess = await authenticateOwnerWithLedger({
        client: ledgerClient,
        accountId: account,
        publicKey: device.publicKey,
        derivationPath: device.derivationPath,
        onPrompt: (msg) => {
          setPrompt(msg);
          if (msg.toLowerCase().includes("approve")) setStep("await_device");
          if (msg.toLowerCase().includes("verifying")) setStep("verifying");
        },
      });
      await refreshSession();
      setStep("done");
      setPrompt(
        `Owner verified for ${sess.account_id}. Session cookie set (HttpOnly). No transaction was broadcast.`
      );
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await clearOwner();
      setStep("idle");
      setPrompt(null);
      setError(null);
      setErrorMeta(null);
    } finally {
      setBusy(false);
    }
  };

  const statusBadge = verified
    ? { cls: "nio-badge-success", text: "VERIFIED" }
    : device.connected
      ? { cls: "nio-badge-warn", text: "DEVICE CONNECTED" }
      : { cls: "nio-badge-idle", text: "NOT CONNECTED" };

  const sessionExpired =
    !verified &&
    Boolean(session?.reason?.includes("expired") || errorMeta?.kind === "session_expired");

  return (
    <div className="page-enter nio-owner-auth-page">
      <div className="axis-intro">
        <div>
          <h1>Owner authentication</h1>
          <p>
            Physical Ledger → NEP-413 ownership proof → HttpOnly session → My
            Portfolio. NEP-413 login itself does not authorize trading. Ordinary
            NEAR wallet connect is a separate path. Public Live AI never uses this
            session. Hardware approval is required for a real verified session —
            mock UI below is illustrative only.
          </p>
        </div>
      </div>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Deposit safety</h2>
          <span className="nio-badge nio-badge-danger">BLOCKED</span>
        </div>
        <p className="warn">
          Mainnet deposits are not enabled. Do not send funds.
        </p>
      </section>

      {!webhidOk ? (
        <section className="axis-panel nio-owner-callout">
          <div className="axis-panel-heading">
            <h2>
              <MonitorOff size={16} /> WebHID unsupported
            </h2>
            <span className="nio-badge nio-badge-warn">BROWSER LIMIT</span>
          </div>
          <p>
            This browser cannot talk to a USB Ledger. Use Chrome or Edge on
            desktop to complete owner authentication. You can still browse the
            public demo without a wallet.
          </p>
          <div className="axis-actions">
            <button type="button" className="axis-button secondary" onClick={() => onNav("agent")}>
              Open public AI Agent
            </button>
            <button type="button" className="axis-button secondary" onClick={() => onNav("evidence")}>
              View Gate K evidence
            </button>
          </div>
        </section>
      ) : null}

      {sessionExpired ? (
        <section className="axis-panel nio-owner-callout">
          <div className="axis-panel-heading">
            <h2>Session expired</h2>
            <span className="nio-badge nio-badge-warn">RE-VERIFY</span>
          </div>
          <p>Your previous owner session is no longer valid. Connect Ledger and verify again.</p>
        </section>
      ) : null}

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Session status</h2>
          <span className={`nio-badge ${statusBadge.cls}`}>{statusBadge.text}</span>
        </div>
        <dl className="nio-kv">
          <div>
            <dt>Device</dt>
            <dd>
              {device.connected
                ? `NEAR app ${device.appVersion ?? "?"} · path ${device.derivationPath ?? "—"}`
                : "Disconnected"}
            </dd>
          </div>
          <div>
            <dt>NEAR account</dt>
            <dd className="mono">
              {session?.account_id ||
                device.selectedAccount ||
                manualAccount ||
                "—"}
            </dd>
          </div>
          <div>
            <dt>Public key</dt>
            <dd
              className="mono"
              title={device.publicKey || session?.public_key || undefined}
            >
              {abbreviateKey(device.publicKey || session?.public_key)}
            </dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>NEAR testnet</dd>
          </div>
          <div>
            <dt>Ownership</dt>
            <dd>
              {verified ? (
                <span className="nio-badge nio-badge-success">Proven (NEP-413)</span>
              ) : (
                <span className="nio-badge nio-badge-idle">Unproven</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd className="mono">
              {refreshing
                ? "Checking…"
                : verified
                  ? `Active · expires ${session?.expires_at ?? "—"}`
                  : "None"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Connect Ledger → Verify ownership</h2>
        </div>
        <ol className="nio-owner-steps">
          <li data-active={step === "idle" || step === "connecting"}>
            <Usb size={16} /> Unlock Ledger · open NEAR app ≥2.1 · Connect
          </li>
          <li data-active={step === "select_account"}>
            <KeyRound size={16} /> Select the NEAR account that holds this FullAccess key
          </li>
          <li
            data-active={
              step === "challenging" ||
              step === "await_device" ||
              step === "verifying"
            }
          >
            <ShieldCheck size={16} /> Approve the NEP-413 owner message on device
          </li>
        </ol>

        <div className="axis-form-stack" style={{ marginTop: 16, gap: 12 }}>
          <label className="axis-field">
            <span>Derivation path</span>
            <input
              className="axis-input mono"
              value={path}
              disabled={busy || verified}
              onChange={(e) => setPath(e.target.value)}
              spellCheck={false}
            />
          </label>

          {(step === "select_account" ||
            device.accounts.length > 0 ||
            device.connected) && (
            <>
              {device.accounts.length > 0 ? (
                <label className="axis-field">
                  <span>Discovered accounts</span>
                  <select
                    className="axis-input"
                    disabled={busy || verified}
                    value={device.selectedAccount || ""}
                    onChange={(e) =>
                      setDevice({ selectedAccount: e.target.value || null })
                    }
                  >
                    <option value="">Select account…</option>
                    {device.accounts.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="axis-field">
                <span>Or enter account id</span>
                <input
                  className="axis-input mono"
                  placeholder="alice.testnet"
                  value={manualAccount}
                  disabled={busy || verified}
                  onChange={(e) => setManualAccount(e.target.value)}
                  spellCheck={false}
                />
              </label>
            </>
          )}

          <div className="axis-actions" style={{ flexWrap: "wrap" }}>
            {!verified ? (
              <>
                <button
                  type="button"
                  className="axis-button"
                  disabled={busy || !webhidOk}
                  onClick={() => void connect()}
                >
                  {device.connected ? "Reconnect Ledger" : "Connect Ledger"}
                </button>
                <button
                  type="button"
                  className="axis-button secondary"
                  disabled={
                    busy ||
                    !device.connected ||
                    !(device.selectedAccount || manualAccount.trim())
                  }
                  onClick={() => void verifyOwnership()}
                >
                  {step === "await_device"
                    ? "Waiting for Ledger…"
                    : "Verify ownership"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="axis-button"
                  onClick={() => onNav("my-portfolio")}
                >
                  Open My Portfolio
                </button>
                <button
                  type="button"
                  className="axis-button secondary"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  <LogOut size={16} /> Disconnect / logout
                </button>
              </>
            )}
          </div>
        </div>

        {step === "await_device" ? (
          <p className="nio-owner-device-prompt" role="status">
            Approve the message on your physical Ledger now. This window will wait.
            Rejecting cancels authentication — no transaction is created.
          </p>
        ) : null}
        {prompt ? <p className="axis-supporting">{prompt}</p> : null}
        {errorMeta || error ? (
          <div className="nio-owner-error" role="alert">
            <strong>{errorMeta?.title ?? "Error"}</strong>
            <p>{errorMeta?.recovery}</p>
            {error ? <p className="mono axis-supporting">{error}</p> : null}
            <div className="axis-actions" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="axis-button secondary"
                disabled={busy}
                onClick={() => void connect()}
              >
                Retry connect
              </button>
              <button
                type="button"
                className="axis-button secondary"
                onClick={() => onNav("agent")}
              >
                Continue with public demo
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Available owner actions</h2>
        </div>
        <ul className="nio-owner-actions">
          <li>
            <strong>View My Portfolio</strong> —{" "}
            {verified ? "enabled after verify" : "requires verified session"}
          </li>
          <li>
            <strong>Deposits / withdrawals / policy / signing</strong> —{" "}
            <span className="nio-badge nio-badge-danger">DISABLED</span> until
            the corresponding owner lifecycle is verified on this host
          </li>
          <li>
            <strong>Gate K / autonomous trading</strong> —{" "}
            <span className="nio-badge nio-badge-danger">OFF</span>
          </li>
        </ul>
        <p className="axis-supporting" style={{ marginTop: 12 }}>
          Public judge Live AI demo stays separate under AI Agent — it never uses
          this owner session.
        </p>
        <p className="axis-supporting">
          Owner sessions are network-bound. A verified <strong>testnet</strong>{" "}
          Ledger session does <strong>not</strong> authenticate a mainnet account.
          Mainnet trading and deposit controls stay disabled until Chat 1 confirms
          endpoint contracts and security gates. On-chain mandate status is shown
          only from live portfolio/policy reads — never invented.
        </p>
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>State guide (illustrative)</h2>
          <span className="nio-badge nio-badge-recorded">NOT A LIVE SESSION</span>
        </div>
        <p className="axis-supporting">
          These labels document UX states for judges. They are not proof of Ledger
          authentication and never create an owner session.
        </p>
        <div className="nio-state-guide">
          {STATE_PREVIEW.map((s) => (
            <div key={s.label}>
              <strong>{s.label}</strong>
              <span>{s.detail}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
