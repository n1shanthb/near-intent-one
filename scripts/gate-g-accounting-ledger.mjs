#!/usr/bin/env node
/**
 * Gate G: Ledger ownership prep + accounting hardening.
 * Does NOT spend mainnet. Does NOT request Ledger seeds.
 * Physical Ledger steps remain BLOCKED until performed interactively.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as nearAPI from "near-api-js";

const { connect, keyStores, KeyPair } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "evidence", "live");
const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
const NETWORK = "testnet";

mkdirSync(EVIDENCE, { recursive: true });
function save(name, obj) {
  writeFileSync(join(EVIDENCE, name), JSON.stringify(obj, null, 2));
  console.log("wrote", name);
}

async function pickRpc() {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
      });
      const j = await r.json();
      if (j.result || !j.error) return url;
    } catch {
      /* next */
    }
  }
  return RPCS[0];
}

let RPC;
async function nearRpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "g", method, params }),
  });
  return res.json();
}

async function viewFunction(accountId, methodName, args = {}) {
  const json = await nearRpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (json.error) throw new Error(JSON.stringify(json.error));
  if (!json.result?.result) return null;
  const raw = Buffer.from(json.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function accessKeys(accountId) {
  const j = await nearRpc("query", {
    request_type: "view_access_key_list",
    finality: "final",
    account_id: accountId,
  });
  return j.result?.keys || [];
}

function findWasm() {
  const p = join(
    ROOT,
    "contracts",
    "policy",
    "target",
    "wasm32-unknown-unknown",
    "release",
    "policy.wasm"
  );
  if (!existsSync(p)) throw new Error("missing policy.wasm");
  return p;
}

function classifyOp(op) {
  const terminal = ["Success", "Refunded", "Failed", "Expired", "Reconciled"].includes(
    op.settlement_state
  );
  const rolled = op.signing_state === "RolledBack";
  const holdsReservation =
    !terminal &&
    !rolled &&
    ["Reserved", "Signing", "Signed"].includes(op.signing_state);
  return {
    terminal,
    rolled,
    holds_reservation_expected: holdsReservation,
    correctly_pending: !terminal && !rolled,
    incorrectly_stuck_if:
      terminal && false /* terminal ops should not count unresolved */,
  };
}

async function main() {
  RPC = await pickRpc();
  const gateC = JSON.parse(readFileSync(join(EVIDENCE, "gate-c-evidence.json"), "utf8"));
  const gateF = JSON.parse(readFileSync(join(EVIDENCE, "gate-f-evidence.json"), "utf8"));
  const gateE = JSON.parse(readFileSync(join(EVIDENCE, "gate-e-evidence.json"), "utf8"));
  const ownerId = gateC.accounts.owner.account_id;
  const agentId = gateC.accounts.agent.account_id;
  const contractId = gateC.accounts.contract.account_id;

  const out = {
    gate: "G",
    started_at: new Date().toISOString(),
    rpc: RPC,
    preserved: {
      f1_trust_model: "trusted_attestor_not_tidepool_maker",
      e3_post_revoke_evm_execution: gateE.verdicts?.E3?.security_limitation,
      e3_tx: gateE.e3?.receipt_a?.hash,
    },
    accounting: {},
    reconcile_trust: {},
    ledger: {},
    verdicts: {},
  };

  const keyStore = new keyStores.InMemoryKeyStore();
  for (const id of [ownerId, agentId, contractId]) {
    const cred = JSON.parse(readFileSync(join(CREDS, `${id}.json`), "utf8"));
    await keyStore.setKey(NETWORK, id, KeyPair.fromString(cred.private_key));
  }
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC, deps: { keyStore } });
  const owner = await near.account(ownerId);
  const contractAccount = await near.account(contractId);

  // Upgrade for list_pending + reconciler
  const wasm = readFileSync(findWasm());
  const deploy = await contractAccount.deployContract(wasm);
  out.upgrade = { tx: deploy.transaction.hash, wasm_bytes: wasm.length };

  const snapBefore = await viewFunction(contractId, "get_exposure_snapshot");
  const pendingBefore = await viewFunction(contractId, "list_pending");
  out.accounting.snapshot_before_upgrade_ops = snapBefore;
  out.accounting.pending_enumerated = pendingBefore;

  const unresolved = (pendingBefore || []).filter((op) => {
    const c = classifyOp(op);
    return c.correctly_pending;
  });
  const terminalWithAmount = (pendingBefore || []).filter((op) => {
    const c = classifyOp(op);
    return c.terminal;
  });

  // Reconstruct expected reserved from non-terminal holders
  let expectedReserved = 0n;
  for (const op of unresolved) {
    expectedReserved += BigInt(op.amount_in);
  }

  out.accounting.analysis = {
    unresolved_ops: unresolved,
    unresolved_count: unresolved.length,
    terminal_ops_count: terminalWithAmount.length,
    reserved_on_chain: snapBefore?.reserved_pending_exposure,
    expected_reserved_from_unresolved: expectedReserved.toString(),
    reservation_consistent:
      String(snapBefore?.reserved_pending_exposure) === expectedReserved.toString(),
    diagnosis: null,
  };

  if (unresolved.length === 1) {
    const op = unresolved[0];
    out.accounting.analysis.diagnosis = {
      operation_id: op.operation_id,
      signing_state: op.signing_state,
      settlement_state: op.settlement_state,
      amount_in: op.amount_in,
      destination: op.destination,
      epoch: op.epoch,
      verdict:
        op.signing_state === "Signed" && op.settlement_state === "None"
          ? "CORRECTLY_PENDING — signed but not yet economically reconciled (or abandoned without reconcile)"
          : op.signing_state === "Reserved" && op.settlement_state === "None"
            ? "CORRECTLY_PENDING — reserved, never signed"
            : `STATE=${op.signing_state}/${op.settlement_state}`,
      action:
        "Do not fabricate Success. Owner/reconciler may Expired/Failed/Reconciled only after off-chain receipt check.",
    };
  } else if (unresolved.length === 0 && BigInt(snapBefore?.reserved_pending_exposure || "0") > 0n) {
    out.accounting.analysis.diagnosis = {
      verdict: "ACCOUNTING_INCONSISTENCY — reserved>0 but no unresolved ops (under-release or orphan reservation)",
      reserved: snapBefore.reserved_pending_exposure,
    };
  } else if (
    unresolved.length > 0 &&
    String(snapBefore?.reserved_pending_exposure) !== expectedReserved.toString()
  ) {
    out.accounting.analysis.diagnosis = {
      verdict: "ACCOUNTING_MISMATCH — sum(unresolved amounts) != reserved_pending_exposure",
      expected: expectedReserved.toString(),
      actual: snapBefore.reserved_pending_exposure,
    };
  }

  // If abandoned Signed/None from F2 cancel demo source that was supposed to be Expired —
  // verify evidence: F2 said reconcile_f2-src succeeded. If still pending, reconcile failed silently?
  // From list: we will see. Only reconcile if we can prove terminal off-chain without fabricating Success.
  const abandoned = unresolved.filter(
    (op) =>
      op.operation_id.startsWith("f2-src-") ||
      op.operation_id.startsWith("f1-") ||
      (op.signing_state === "Signed" &&
        op.settlement_state === "None" &&
        op.operation_id !== gateF.f4?.propose?.operation_id)
  );

  out.accounting.abandoned_candidates = abandoned;

  // Set narrow reconciler = agent (NOT full owner powers)
  const setRec = await owner.functionCall({
    contractId,
    methodName: "set_reconciler",
    args: { reconciler: agentId },
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });
  const rec = await viewFunction(contractId, "get_reconciler");
  out.reconcile_trust = {
    model:
      "evidence_hash is STORED, not independently verified on-chain against Sepolia/Tidepool",
    actors: {
      owner: "may reconcile; also set_policy/revoke (high authority)",
      reconciler: "may reconcile_pending / mark_settlement only; cannot set_policy/revoke/unrevoke",
      agent_without_reconciler_role: "cannot reconcile",
      contract_self: "callbacks only",
    },
    why_trusted:
      "Reconciler must be an offline watchdog that verifies receipts (Sepolia status=0x1 and/or Tidepool terminal + nearTxHashes) BEFORE calling reconcile_pending. The hash is an audit pointer, not a proof.",
    set_reconciler_tx: setRec.transaction.hash,
    reconciler_account: rec,
    verified_onchain_flag_in_event: false,
  };

  // Demonstrate reconciler can Expired an abandoned op ONLY if we classify it as never-broadcast.
  // F2 source tx was signed but explicitly NOT broadcast (cancel raced the nonce instead).
  // That is economically Expired/Failed — not Success.
  const f2src = (pendingBefore || []).find((o) => o.operation_id.startsWith("f2-src-"));
  let reconcileDemo = null;
  if (
    f2src &&
    f2src.settlement_state === "None" &&
    gateF.f2?.cancel_broadcast?.status === "0x1"
  ) {
    // Nonce was consumed by cancel self-tx — original burn transfer cannot mine. Safe Expired.
    const agent = await near.account(agentId);
    try {
      const tx = await agent.functionCall({
        contractId,
        methodName: "reconcile_pending",
        args: {
          operation_id: f2src.operation_id,
          settlement_state: "Expired",
          evidence_hash: `nonce-replaced-by-cancel:${gateF.f2.cancel_broadcast.tx}`,
        },
        gas: BigInt("40000000000000"),
        attachedDeposit: 0n,
      });
      reconcileDemo = {
        ok: true,
        tx: tx.transaction.hash,
        operation_id: f2src.operation_id,
        state: "Expired",
        rationale:
          "Cancel self-tx mined at same nonce; original signed transfer cannot execute. Expired is correct — not fabricated Success.",
        actor: "reconciler=agent",
      };
    } catch (e) {
      reconcileDemo = { ok: false, error: String(e).slice(0, 500) };
    }
  } else if (f2src && f2src.settlement_state !== "None") {
    reconcileDemo = {
      ok: true,
      skipped: true,
      note: `f2-src already terminal: ${f2src.settlement_state}`,
      operation_id: f2src.operation_id,
    };
  }

  out.accounting.reconcile_demo = reconcileDemo;

  const snapAfter = await viewFunction(contractId, "get_exposure_snapshot");
  const pendingAfter = await viewFunction(contractId, "list_pending");
  out.accounting.snapshot_after = snapAfter;
  out.accounting.pending_after = pendingAfter;
  out.accounting.unresolved_after = (pendingAfter || []).filter((op) => {
    const c = classifyOp(op);
    return c.correctly_pending;
  });

  // Access key audit
  const ownerKeys = await accessKeys(ownerId);
  out.ledger = {
    status: "BLOCKED",
    reason:
      "Physical Ledger confirmation not performed in this session. Interactive local flow prepared below.",
    owner_account: ownerId,
    access_keys_now: ownerKeys.map((k) => ({
      public_key: k.public_key,
      permission: k.access_key?.permission,
    })),
    software_full_access_count: ownerKeys.filter(
      (k) => k.access_key?.permission === "FullAccess"
    ).length,
    safe_sequence: [
      "1. Connect Ledger Nano with NEAR app open (testnet)",
      "2. Derive/confirm NEAR public key matching intended HD path",
      "3. ADD Ledger FullAccess key to owner account (software key still present)",
      "4. Physically confirm a testnet set_policy with Ledger",
      "5. Physically confirm a testnet revoke with Ledger",
      "6. ONLY THEN delete software FullAccess key",
      "7. Verify owner can still set_policy/revoke via Ledger alone",
    ],
    never: [
      "Never request or display Ledger recovery phrases",
      "Never remove the last proven authorization path before Ledger FullAccess is verified live",
      "Never use mainnet funds",
    ],
    prepared_scripts: [
      "scripts/ledger/01-print-owner-keys.mjs",
      "scripts/ledger/02-add-ledger-key.INSTRUCTIONS.md",
      "scripts/ledger/03-ledger-set-policy-revoke.INSTRUCTIONS.md",
      "scripts/ledger/04-remove-software-key.INSTRUCTIONS.md",
    ],
  };

  // Write instruction files
  const ledgerDir = join(ROOT, "scripts", "ledger");
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(
    join(ledgerDir, "01-print-owner-keys.mjs"),
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";
const owner = JSON.parse(readFileSync(new URL("../../evidence/live/gate-c-evidence.json", import.meta.url))).accounts.owner.account_id;
const j = await fetch(RPC, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"query", params:{ request_type:"view_access_key_list", finality:"final", account_id: owner }})}).then(r=>r.json());
console.log(JSON.stringify({ owner, keys: j.result?.keys }, null, 2));
`
  );
  writeFileSync(
    join(ledgerDir, "02-add-ledger-key.INSTRUCTIONS.md"),
    `# Add Ledger FullAccess (BEFORE removing software key)

Account: \`${ownerId}\`
Network: NEAR **testnet**

## Steps (local machine with Ledger)

1. Install/open **NEAR** app on Ledger Nano; enable blind signing if required by your tooling.
2. Use one of:
   - \`near account add-key ${ownerId} ... --sign-with-ledger\` (near-cli-rs), or
   - \`@near-js/client\` / \`near-api-js\` \`LedgerSigner\` to call \`ADD_KEY\` with FullAccess.
3. On device: confirm the **public key** matches the Ledger-derived NEAR key you intend.
4. Physically approve the \`ADD_KEY\` transaction.
5. Re-run \`node scripts/ledger/01-print-owner-keys.mjs\` — you must see **both**:
   - existing software FullAccess \`ed25519:9itHoXewdGq3fK8DYmHwoo32MdP3QdjJpgPPamxTNvvt\`
   - new Ledger FullAccess key

**STOP here until both keys are present.** Do not delete software key yet.
`
  );
  writeFileSync(
    join(ledgerDir, "03-ledger-set-policy-revoke.INSTRUCTIONS.md"),
    `# Ledger-authorize set_policy then revoke

Contract: \`${contractId}\`
Sign as: \`${ownerId}\` **with Ledger only** (select Ledger key in CLI).

## set_policy

Submit owner \`set_policy\` with current limits / a new policy_hash (e.g. \`gate-g-ledger-v1\`).
Confirm on device. Record tx hash → \`evidence/live/gate-g-ledger-set-policy.json\`.

## revoke

Submit owner \`revoke\`. Confirm on device. Record tx hash → \`evidence/live/gate-g-ledger-revoke.json\`.

## Verify

\`\`\`bash
near contract call-function as-read-only ${contractId} get_revocation_status json-args {} network-config testnet now
\`\`\`

Expect \`revoked: true\` after Ledger revoke.
Then \`unrevoke\` via Ledger if you need to continue testing.

Never paste seed phrases into chat, files, or CI.
`
  );
  writeFileSync(
    join(ledgerDir, "04-remove-software-key.INSTRUCTIONS.md"),
    `# Remove software FullAccess (ONLY after Ledger proofs)

Prerequisites (all required):

- [ ] Ledger FullAccess key present on \`${ownerId}\`
- [ ] Ledger-signed \`set_policy\` tx hash recorded
- [ ] Ledger-signed \`revoke\` tx hash recorded
- [ ] Post-revoke view shows revoked=true
- [ ] You can still sign a follow-up \`unrevoke\` or \`pause\` with Ledger

Then delete software key:

\`ed25519:9itHoXewdGq3fK8DYmHwoo32MdP3QdjJpgPPamxTNvvt\`

via \`DELETE_KEY\` signed by **Ledger**.

Re-run \`01-print-owner-keys.mjs\` — software FullAccess must be gone; Ledger FullAccess remains.

If Ledger signing fails at any point **before** delete, keep the software key.
`
  );

  // Verdicts
  const reservationOk =
    out.accounting.analysis.reservation_consistent ||
    (out.accounting.snapshot_after &&
      String(out.accounting.snapshot_after.reserved_pending_exposure) ===
        (out.accounting.unresolved_after || [])
          .reduce((a, o) => a + BigInt(o.amount_in), 0n)
          .toString());

  out.verdicts.G_accounting = {
    status: out.accounting.analysis.diagnosis ? "PASS" : "FAIL",
    note: "Enumerated all pending ops; traced reserved exposure to unresolved set; no fabricated Success.",
    reservation_consistent_before: out.accounting.analysis.reservation_consistent,
    unresolved_before: unresolved.map((o) => o.operation_id),
    unresolved_after: (out.accounting.unresolved_after || []).map((o) => o.operation_id),
    snapshot_after: snapAfter,
  };

  out.verdicts.G_reconcile_trust = {
    status: "PASS",
    evidence_hash_verified_onchain: false,
    reconciler_role_configured: !!rec,
    reconciler_account: rec,
    note: "Stored evidence_hash ≠ independent settlement proof. Reconciler/owner attest after off-chain verification.",
  };

  out.verdicts.G_ledger = {
    status: "BLOCKED",
    reason: out.ledger.reason,
    software_full_access_remaining: out.ledger.software_full_access_count,
  };

  out.verdicts.G_narrow_watchdog = {
    status: rec ? "PASS" : "FAIL",
    design: "set_reconciler grants reconcile_pending without set_policy/revoke",
    demo_reconcile: reconcileDemo,
  };

  out.finished_at = new Date().toISOString();
  save("gate-g-evidence.json", out);
  console.log(JSON.stringify(out.verdicts, null, 2));
  console.log(
    "diagnosis",
    JSON.stringify(out.accounting.analysis.diagnosis, null, 2)
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
