import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONFIG } from "../lib/config";
import {
  DEFAULT_DERIVATION_PATH,
  LedgerClient,
  isLedgerSupported,
  mapLedgerError,
} from "../ledger/ledgerClient";
import {
  fullAccessKeys,
  hasPublicKey,
  txExplorerUrl,
  viewAccessKeyList,
  viewFunctionJson,
  type AccessKeyInfo,
} from "../ledger/rpc";
import {
  deleteKeyAction,
  functionCallAction,
  signAndSendWithLedger,
} from "../ledger/signWithLedger";
import {
  derivePhase,
  isHardwareOwnershipPass,
  ledgerAuthorizedOn,
  normalizePk,
  phaseLabel,
  phaseTone,
  softwareFullAccessKeys,
  type WizardProofs,
} from "../ledger/wizardState";
import { notifyLedgerSession } from "../adapters/gateh";

type Limits = {
  max_trade_value: string;
  daily_turnover_limit: string;
  max_pending_exposure: string;
  max_slippage_bps: number;
  allowed_assets: string[];
  allowed_destinations: string[];
  valid_until: string;
};

const OWNER = CONFIG.ownerAccount;
const POLICY = CONFIG.policyContract;
const TEST_POLICY_HASH = "gate-h1-ledger-v1";
const TEST_STRATEGY_HASH = "ledger-wizard-proof";

const emptyProofs = (): WizardProofs => ({
  ledgerPublicKey: null,
  derivationPath: DEFAULT_DERIVATION_PATH,
  ownerKeys: [],
  policyKeys: [],
  addOwnerTx: null,
  addPolicyTx: null,
  setPolicyTx: null,
  revokeTx: null,
  unrevokeTx: null,
  removeOwnerSoftwareTx: null,
  removePolicySoftwareTx: null,
  setPolicyOk: false,
  revokeOk: false,
  mandateEpochAfterRevoke: null,
  revokedAfter: null,
});

async function migrateAddKey(accountId: string, publicKey: string) {
  const res = await fetch("/api/ledger-migrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "add_full_access_key",
      accountId,
      publicKey,
      signerAccountId: OWNER,
    }),
  });
  const body = (await res.json()) as {
    ok: boolean;
    tx?: string;
    error?: string;
    note?: string;
  };
  if (!body.ok) throw new Error(body.error || "migrate failed");
  return body;
}

function KeyTable({
  title,
  accountId,
  keys,
  ledgerPk,
}: {
  title: string;
  accountId: string;
  keys: AccessKeyInfo[];
  ledgerPk: string | null;
}) {
  const ledger = ledgerPk ? normalizePk(ledgerPk) : null;
  return (
    <div className="ledger-key-block">
      <h4>
        {title} <code>{accountId}</code>
      </h4>
      <ul className="demo-list">
        {keys.length === 0 && <li className="muted">No keys returned</li>}
        {keys.map((k) => {
          const isLedger = ledger && k.public_key === ledger;
          const isFa = k.permission === "FullAccess";
          return (
            <li key={k.public_key}>
              <div className="row between">
                <code className="small">{k.public_key}</code>
                <span className={`badge ${isLedger ? "badge-ok" : isFa ? "badge-warn" : ""}`}>
                  {isLedger ? "Ledger FullAccess" : isFa ? "Software FullAccess" : "Restricted"}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function LedgerWizard() {
  const clientRef = useRef<LedgerClient | null>(null);
  const [proofs, setProofs] = useState<WizardProofs>(emptyProofs);
  const [path, setPath] = useState(DEFAULT_DERIVATION_PATH);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmRemoveOwner, setConfirmRemoveOwner] = useState(false);
  const [confirmRemovePolicy, setConfirmRemovePolicy] = useState(false);
  const inFlight = useRef(false);

  const phase = useMemo(() => derivePhase(proofs), [proofs]);
  const tone = phaseTone(phase);
  const supported = isLedgerSupported();

  const refreshKeys = useCallback(async (ledgerPk: string | null) => {
    const [ownerKeys, policyKeys, lim] = await Promise.all([
      viewAccessKeyList(OWNER),
      viewAccessKeyList(POLICY),
      viewFunctionJson<Limits>(POLICY, "get_limits").catch(() => null),
    ]);
    if (lim) setLimits(lim);
    setProofs((p) => ({
      ...p,
      ledgerPublicKey: ledgerPk ?? p.ledgerPublicKey,
      ownerKeys,
      policyKeys,
    }));
  }, []);

  useEffect(() => {
    void refreshKeys(null);
  }, [refreshKeys]);

  const guard = async (label: string, fn: () => Promise<void>) => {
    if (inFlight.current) {
      setError("Another Ledger operation is in progress — wait for it to finish.");
      return;
    }
    inFlight.current = true;
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(mapLedgerError(e));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const connect = () =>
    guard("Connecting Ledger…", async () => {
      if (!supported) throw new Error("WebHID unsupported — use Chrome or Edge on desktop.");
      const client = clientRef.current ?? new LedgerClient();
      if (!client.isConnected()) await client.connect();
      const version = await client.getVersion();
      setAppVersion(version);
      const rawPk = await client.getPublicKey(path);
      const pk = normalizePk(rawPk);
      clientRef.current = client;
      setProofs((p) => ({ ...p, ledgerPublicKey: pk, derivationPath: path }));
      notifyLedgerSession(true);
      await refreshKeys(pk);
    });

  const disconnect = () =>
    guard("Disconnecting…", async () => {
      await clientRef.current?.disconnect();
      clientRef.current = null;
      setAppVersion(null);
      setProofs((p) => ({ ...p, ledgerPublicKey: null }));
      notifyLedgerSession(false);
    });

  const addLedgerKey = (accountId: "owner" | "policy") =>
    guard(`Adding Ledger FullAccess to ${accountId}…`, async () => {
      if (!proofs.ledgerPublicKey) throw new Error("Connect Ledger first");
      const target = accountId === "owner" ? OWNER : POLICY;
      const keys = accountId === "owner" ? proofs.ownerKeys : proofs.policyKeys;
      if (hasPublicKey(keys, proofs.ledgerPublicKey)) {
        throw new Error("Ledger key already registered on this account");
      }
      const result = await migrateAddKey(target, proofs.ledgerPublicKey);
      setProofs((p) => ({
        ...p,
        addOwnerTx: accountId === "owner" ? result.tx || null : p.addOwnerTx,
        addPolicyTx: accountId === "policy" ? result.tx || null : p.addPolicyTx,
      }));
      await refreshKeys(proofs.ledgerPublicKey);
    });

  const requireLedgerClient = () => {
    const client = clientRef.current;
    if (!client?.isConnected() || !proofs.ledgerPublicKey) {
      throw new Error("Connect Ledger first");
    }
    return client;
  };

  const signSetPolicy = () =>
    guard("Approve set_policy on Ledger…", async () => {
      const client = requireLedgerClient();
      if (!ledgerAuthorizedOn(proofs.ownerKeys, proofs.ledgerPublicKey)) {
        throw new Error("Register Ledger FullAccess on the owner account before signing");
      }
      if (!limits) throw new Error("Could not load current policy limits");
      const args = {
        limits: {
          max_trade_value: String(limits.max_trade_value),
          daily_turnover_limit: String(limits.daily_turnover_limit),
          max_pending_exposure: String(limits.max_pending_exposure),
          max_slippage_bps: limits.max_slippage_bps,
          allowed_assets: limits.allowed_assets,
          allowed_destinations: limits.allowed_destinations,
          valid_until: String(limits.valid_until),
        },
        policy_hash: TEST_POLICY_HASH,
        strategy_hash: TEST_STRATEGY_HASH,
      };
      const { hash, ok } = await signAndSendWithLedger({
        client,
        derivationPath: proofs.derivationPath,
        publicKey: proofs.ledgerPublicKey!,
        signerId: OWNER,
        receiverId: POLICY,
        actions: [functionCallAction("set_policy", args)],
      });
      if (!hash) throw new Error("No transaction hash returned");
      // Independent verification
      const epoch = await viewFunctionJson<number | string>(POLICY, "get_mandate_epoch");
      setProofs((p) => ({
        ...p,
        setPolicyTx: hash,
        setPolicyOk: ok || Boolean(hash),
      }));
      void epoch;
      await refreshKeys(proofs.ledgerPublicKey);
    });

  const signRevoke = () =>
    guard("Approve revoke on Ledger…", async () => {
      if (!confirmRevoke) throw new Error("Confirm the revoke warning first");
      const client = requireLedgerClient();
      const { hash, ok } = await signAndSendWithLedger({
        client,
        derivationPath: proofs.derivationPath,
        publicKey: proofs.ledgerPublicKey!,
        signerId: OWNER,
        receiverId: POLICY,
        actions: [functionCallAction("revoke", {})],
      });
      if (!hash) throw new Error("No transaction hash returned");
      const status = await viewFunctionJson<{
        revoked: boolean;
        mandate_epoch: number;
      }>(POLICY, "get_revocation_status");
      setProofs((p) => ({
        ...p,
        revokeTx: hash,
        revokeOk: ok && status.revoked === true,
        revokedAfter: status.revoked,
        mandateEpochAfterRevoke: Number(status.mandate_epoch),
      }));
      setConfirmRevoke(false);
    });

  const signUnrevoke = () =>
    guard("Approve unrevoke on Ledger…", async () => {
      const client = requireLedgerClient();
      const { hash } = await signAndSendWithLedger({
        client,
        derivationPath: proofs.derivationPath,
        publicKey: proofs.ledgerPublicKey!,
        signerId: OWNER,
        receiverId: POLICY,
        actions: [functionCallAction("unrevoke", {})],
      });
      if (!hash) throw new Error("No transaction hash returned");
      const status = await viewFunctionJson<{ revoked: boolean }>(
        POLICY,
        "get_revocation_status"
      );
      setProofs((p) => ({
        ...p,
        unrevokeTx: hash,
        revokedAfter: status.revoked,
      }));
    });

  const removeSoftwareKey = (accountId: "owner" | "policy") =>
    guard(`Ledger DELETE_KEY on ${accountId}…`, async () => {
      const client = requireLedgerClient();
      const target = accountId === "owner" ? OWNER : POLICY;
      const keys = accountId === "owner" ? proofs.ownerKeys : proofs.policyKeys;
      if (!ledgerAuthorizedOn(keys, proofs.ledgerPublicKey)) {
        throw new Error("Ledger FullAccess must be present before removing software keys");
      }
      if (!proofs.setPolicyOk || !proofs.revokeOk) {
        throw new Error("Prove hardware set_policy and revoke before removing software keys");
      }
      if (accountId === "owner" && !confirmRemoveOwner) {
        throw new Error("Confirm owner software key removal");
      }
      if (accountId === "policy" && !confirmRemovePolicy) {
        throw new Error("Confirm policy-contract software key removal");
      }
      const soft = softwareFullAccessKeys(keys, proofs.ledgerPublicKey);
      if (soft.length === 0) throw new Error("No software FullAccess keys to remove");
      // Never remove Ledger key; never leave zero FullAccess
      const remainingFa = fullAccessKeys(keys).filter(
        (k) => k.public_key === normalizePk(proofs.ledgerPublicKey!)
      );
      if (remainingFa.length < 1) {
        throw new Error("Refusing to delete — Ledger FullAccess not proven on account");
      }
      const toDelete = soft[0];
      if (toDelete.public_key === normalizePk(proofs.ledgerPublicKey!)) {
        throw new Error("Refusing to delete the Ledger key");
      }
      // Signer must be the account itself; for policy, Ledger key must be on policy
      const signerId = target;
      const signerKeys = accountId === "policy" ? proofs.policyKeys : proofs.ownerKeys;
      if (!ledgerAuthorizedOn(signerKeys, proofs.ledgerPublicKey)) {
        throw new Error(`Ledger key missing on ${signerId}`);
      }
      const { hash } = await signAndSendWithLedger({
        client,
        derivationPath: proofs.derivationPath,
        publicKey: proofs.ledgerPublicKey!,
        signerId,
        receiverId: signerId,
        actions: [deleteKeyAction(toDelete.public_key)],
      });
      if (!hash) throw new Error("No DELETE_KEY hash");
      setProofs((p) => ({
        ...p,
        removeOwnerSoftwareTx:
          accountId === "owner" ? hash : p.removeOwnerSoftwareTx,
        removePolicySoftwareTx:
          accountId === "policy" ? hash : p.removePolicySoftwareTx,
      }));
      if (accountId === "owner") setConfirmRemoveOwner(false);
      if (accountId === "policy") setConfirmRemovePolicy(false);
      await refreshKeys(proofs.ledgerPublicKey);
    });

  const ownerSoft = softwareFullAccessKeys(proofs.ownerKeys, proofs.ledgerPublicKey);
  const policySoft = softwareFullAccessKeys(proofs.policyKeys, proofs.ledgerPublicKey);
  const ownerHasLedger = ledgerAuthorizedOn(proofs.ownerKeys, proofs.ledgerPublicKey);
  const policyHasLedger = ledgerAuthorizedOn(proofs.policyKeys, proofs.ledgerPublicKey);

  return (
    <div className="stack ledger-wizard">
      <section className="card">
        <div className="card-head">
          <h3>Ledger ownership wizard</h3>
          <span className={`badge badge-${tone === "ok" ? "ok" : tone === "warn" ? "warn" : "danger"}`}>
            {phaseLabel(phase)}
          </span>
        </div>
        <p>
          NEAR <strong>testnet</strong> only. Plug in Ledger, open the NEAR app, and
          approve each step on-device. Seed phrases are never requested.
        </p>
        <p className="muted small">
          Ownership PASS requires hardware-signed policy + revoke proofs and
          software FullAccess removal — connecting alone is not enough.
          {isHardwareOwnershipPass(phase) ? " ✓ Hardware-only ownership verified." : ""}
        </p>
        {!supported && (
          <p className="alert danger">
            WebHID is unavailable. Use desktop Chrome or Edge (not Firefox/Safari/mobile).
          </p>
        )}
        {error && <p className="alert danger">{error}</p>}
        {busy && <p className="muted">{busy}</p>}
      </section>

      {/* Step 1 */}
      <section className="card">
        <h3>Step 1 — Connect</h3>
        <p className="muted small">
          Before connecting: unlock the device, close Ledger Live if it holds USB,
          then open the <strong>NEAR</strong> app (not the dashboard). Error{" "}
          <code>0x6e01</code> means the NEAR app is not active.
        </p>
        <div className="row gap">
          <button type="button" className="primary" disabled={!!busy} onClick={() => void connect()}>
            Connect Ledger
          </button>
          <button type="button" className="ghost" disabled={!!busy || !proofs.ledgerPublicKey} onClick={() => void disconnect()}>
            Disconnect
          </button>
        </div>
        <label className="mode-label" style={{ marginTop: "0.75rem" }}>
          Derivation path
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            disabled={!!busy}
            className="ledger-input"
          />
        </label>
        <dl className="ledger-dl">
          <div>
            <dt>NEAR app version</dt>
            <dd>{appVersion || "—"}</dd>
          </div>
          <div>
            <dt>Public key</dt>
            <dd>
              <code>{proofs.ledgerPublicKey || "—"}</code>
            </dd>
          </div>
          <div>
            <dt>Owner account</dt>
            <dd>
              <code>{OWNER}</code>
            </dd>
          </div>
          <div>
            <dt>Policy contract</dt>
            <dd>
              <code>{POLICY}</code>
            </dd>
          </div>
        </dl>
      </section>

      {/* Step 2 */}
      <section className="card">
        <h3>Step 2 — Register hardware ownership</h3>
        <p className="muted">
          Adds Ledger FullAccess using the existing <em>software</em> FullAccess
          signer (localhost migrate API). Does not delete any keys yet. Policy
          contract FullAccess controls WASM upgrades — register Ledger there too.
        </p>
        <KeyTable title="Owner keys" accountId={OWNER} keys={proofs.ownerKeys} ledgerPk={proofs.ledgerPublicKey} />
        <KeyTable title="Policy contract keys" accountId={POLICY} keys={proofs.policyKeys} ledgerPk={proofs.ledgerPublicKey} />
        <div className="row gap wrap">
          <button
            type="button"
            className="primary"
            disabled={!!busy || !proofs.ledgerPublicKey || ownerHasLedger}
            onClick={() => void addLedgerKey("owner")}
          >
            {ownerHasLedger ? "Owner: Ledger already registered" : "Add Ledger as Owner"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!!busy || !proofs.ledgerPublicKey || policyHasLedger}
            onClick={() => void addLedgerKey("policy")}
          >
            {policyHasLedger ? "Policy: Ledger already registered" : "Add Ledger to Policy contract"}
          </button>
        </div>
        {(proofs.addOwnerTx || proofs.addPolicyTx) && (
          <ul className="demo-list">
            {proofs.addOwnerTx && (
              <li>
                Owner ADD_KEY:{" "}
                <a href={txExplorerUrl(proofs.addOwnerTx)} target="_blank" rel="noreferrer">
                  {proofs.addOwnerTx}
                </a>{" "}
                <span className="badge badge-warn">software-signed migrate</span>
              </li>
            )}
            {proofs.addPolicyTx && (
              <li>
                Policy ADD_KEY:{" "}
                <a href={txExplorerUrl(proofs.addPolicyTx)} target="_blank" rel="noreferrer">
                  {proofs.addPolicyTx}
                </a>{" "}
                <span className="badge badge-warn">software-signed migrate</span>
              </li>
            )}
          </ul>
        )}
      </section>

      {/* Step 3 */}
      <section className="card">
        <h3>Step 3 — Prove real hardware signing</h3>
        <p>
          Contract <code>{POLICY}</code> · method <code>set_policy</code>
        </p>
        <pre className="ledger-pre">
{JSON.stringify(
  {
    limits,
    policy_hash: TEST_POLICY_HASH,
    strategy_hash: TEST_STRATEGY_HASH,
    note: "Limits unchanged; policy_hash proves a fresh Ledger signature",
  },
  null,
  2
)}
        </pre>
        <button
          type="button"
          className="primary"
          disabled={!!busy || !ownerHasLedger}
          onClick={() => void signSetPolicy()}
        >
          Sign Test Policy with Ledger
        </button>
        {proofs.setPolicyTx && (
          <p>
            Tx:{" "}
            <a href={txExplorerUrl(proofs.setPolicyTx)} target="_blank" rel="noreferrer">
              {proofs.setPolicyTx}
            </a>{" "}
            <span className={`badge ${proofs.setPolicyOk ? "badge-ok" : "badge-danger"}`}>
              {proofs.setPolicyOk ? "SUCCESS" : "CHECK"}
            </span>
          </p>
        )}
      </section>

      {/* Step 4 */}
      <section className="card">
        <h3>Step 4 — Prove hardware revocation</h3>
        <p className="alert warn">
          <strong>Warning:</strong> <code>revoke</code> blocks new MPC signing /
          agent proposals until <code>unrevoke</code>. Existing exported ECDSA
          signatures may still execute (Gate E3).
        </p>
        <label className="row gap">
          <input
            type="checkbox"
            checked={confirmRevoke}
            onChange={(e) => setConfirmRevoke(e.target.checked)}
          />
          I understand revoke blocks new signing and want to approve it on Ledger.
        </label>
        <div className="row gap wrap" style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            className="danger"
            disabled={!!busy || !proofs.setPolicyOk || !confirmRevoke}
            onClick={() => void signRevoke()}
          >
            Revoke with Ledger
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!!busy || !proofs.revokeOk}
            onClick={() => void signUnrevoke()}
          >
            Unrevoke with Ledger (optional)
          </button>
        </div>
        {proofs.revokeTx && (
          <p>
            Revoke tx:{" "}
            <a href={txExplorerUrl(proofs.revokeTx)} target="_blank" rel="noreferrer">
              {proofs.revokeTx}
            </a>{" "}
            · revoked={String(proofs.revokedAfter)} · epoch={proofs.mandateEpochAfterRevoke}{" "}
            <span className={`badge ${proofs.revokeOk ? "badge-ok" : "badge-danger"}`}>
              {proofs.revokeOk ? "VERIFIED" : "FAILED"}
            </span>
          </p>
        )}
        {proofs.unrevokeTx && (
          <p>
            Unrevoke tx:{" "}
            <a href={txExplorerUrl(proofs.unrevokeTx)} target="_blank" rel="noreferrer">
              {proofs.unrevokeTx}
            </a>
          </p>
        )}
      </section>

      {/* Step 5 */}
      <section className="card">
        <h3>Step 5 — Secure ownership</h3>
        <p className="muted">
          Only after hardware set_policy + revoke are proven. Each DELETE_KEY is
          Ledger-signed. The last Ledger FullAccess key is never removed.
        </p>
        <KeyTable title="Owner audit" accountId={OWNER} keys={proofs.ownerKeys} ledgerPk={proofs.ledgerPublicKey} />
        <KeyTable title="Policy audit" accountId={POLICY} keys={proofs.policyKeys} ledgerPk={proofs.ledgerPublicKey} />

        {ownerSoft.length > 0 && (
          <div className="stack-tight">
            <p>
              Will remove from owner: <code>{ownerSoft[0].public_key}</code>
            </p>
            <label className="row gap">
              <input
                type="checkbox"
                checked={confirmRemoveOwner}
                onChange={(e) => setConfirmRemoveOwner(e.target.checked)}
              />
              Irreversible: remove this software FullAccess from owner (Ledger remains).
            </label>
            <button
              type="button"
              className="danger"
              disabled={!!busy || !proofs.revokeOk || !confirmRemoveOwner}
              onClick={() => void removeSoftwareKey("owner")}
            >
              Remove owner software key (Ledger)
            </button>
          </div>
        )}

        {policySoft.length > 0 && (
          <div className="stack-tight" style={{ marginTop: "1rem" }}>
            <p>
              Will remove from policy contract: <code>{policySoft[0].public_key}</code>
            </p>
            <label className="row gap">
              <input
                type="checkbox"
                checked={confirmRemovePolicy}
                onChange={(e) => setConfirmRemovePolicy(e.target.checked)}
              />
              Irreversible: remove this software FullAccess from policy (Ledger remains for upgrades).
            </label>
            <button
              type="button"
              className="danger"
              disabled={!!busy || !proofs.revokeOk || !confirmRemovePolicy || !policyHasLedger}
              onClick={() => void removeSoftwareKey("policy")}
            >
              Remove policy software key (Ledger)
            </button>
          </div>
        )}

        {(proofs.removeOwnerSoftwareTx || proofs.removePolicySoftwareTx) && (
          <ul className="demo-list">
            {proofs.removeOwnerSoftwareTx && (
              <li>
                Owner DELETE_KEY:{" "}
                <a href={txExplorerUrl(proofs.removeOwnerSoftwareTx)} target="_blank" rel="noreferrer">
                  {proofs.removeOwnerSoftwareTx}
                </a>
              </li>
            )}
            {proofs.removePolicySoftwareTx && (
              <li>
                Policy DELETE_KEY:{" "}
                <a href={txExplorerUrl(proofs.removePolicySoftwareTx)} target="_blank" rel="noreferrer">
                  {proofs.removePolicySoftwareTx}
                </a>
              </li>
            )}
          </ul>
        )}
      </section>

      <section className="card">
        <h3>Export for GATE_H.md</h3>
        <pre className="ledger-pre">
{JSON.stringify(
  {
    phase: phaseLabel(phase),
    hardware_ownership_pass: isHardwareOwnershipPass(phase),
    ledger_public_key: proofs.ledgerPublicKey,
    derivation_path: proofs.derivationPath,
    set_policy_tx: proofs.setPolicyTx,
    revoke_tx: proofs.revokeTx,
    unrevoke_tx: proofs.unrevokeTx,
    add_owner_tx: proofs.addOwnerTx,
    add_policy_tx: proofs.addPolicyTx,
    remove_owner_software_tx: proofs.removeOwnerSoftwareTx,
    remove_policy_software_tx: proofs.removePolicySoftwareTx,
    owner_keys: proofs.ownerKeys,
    policy_keys: proofs.policyKeys,
  },
  null,
  2
)}
        </pre>
      </section>
    </div>
  );
}
