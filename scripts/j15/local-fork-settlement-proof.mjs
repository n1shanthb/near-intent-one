#!/usr/bin/env node
/**
 * J15 P0/P2 — LOCAL_FORK settlement proof.
 * Real ECDSA → EIP-155 raw → journal → local broadcast → receipt → settle → reconcile.
 * Explicitly NOT a mainnet autonomous settlement.
 * HARD STOP: no mainnet mutation.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import {
  deterministicTradeScenario,
  runAutonomousExecution,
} from "../../packages/autonomous/executionService.mjs";
import { EXEC_MODE } from "../../packages/autonomous/executorAdapter.mjs";
import {
  signEip155WithLocalKey,
  generateLocalForkSigner,
  createLocalForkRpc,
  verifySettlementFromReceipt,
  validateSignedRawAgainstPolicy,
} from "../../packages/autonomous/signedTxPipeline.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC shape
const DEPOSIT = "0x407a7c4013eebd3e5d398a76b8d943c4f49c7100";
const AMOUNT = "1000000"; // $1
const CHAIN_ID = 31337;
const GAS_PRICE = "1000000000";
const GAS_LIMIT = "100000";

const signer = generateLocalForkSigner();
const fork = createLocalForkRpc({
  chainId: CHAIN_ID,
  signerAddress: signer.address,
  startNonce: 0,
});

const lockedTx = {
  nonce: 0,
  gasPrice: GAS_PRICE,
  gasLimit: GAS_LIMIT,
  token: TOKEN,
  depositAddress: DEPOSIT,
  amount: AMOUNT,
  chainId: CHAIN_ID,
  expectedMpc: signer.address,
  maxGasPrice: "2000000000",
  maxGasLimit: "300000",
};

const assembled = signEip155WithLocalKey({
  privateKeyHex: signer.privateKeyHex,
  ...lockedTx,
});

const report = {
  kind: "J15_LOCAL_FORK_SETTLEMENT_PROOF",
  started_at: new Date().toISOString(),
  hard_stop_mainnet: true,
  label: "LOCAL_FORK",
  note: "Not a mainnet autonomous settlement. Local JSON-RPC fork only.",
  signer: { address: signer.address, label: signer.label },
  assembled: {
    ok: assembled.ok,
    digest_hex: assembled.digest_hex,
    recovered: assembled.recovered,
    raw_prefix: assembled.rawHex?.slice(0, 20),
    raw_len: assembled.rawHex?.length,
  },
  gates: {},
};

if (!assembled.ok) {
  report.verdict = "NO_GO";
  report.error = assembled.reason;
  writeFileSync(
    join(EVIDENCE, "J15_LOCAL_FORK_SETTLEMENT_PROOF.json"),
    JSON.stringify(report, null, 2)
  );
  process.exit(1);
}

const validated = validateSignedRawAgainstPolicy({
  signedRawHex: assembled.rawHex,
  expected: {
    chainId: CHAIN_ID,
    nonce: 0,
    token: TOKEN,
    mpc: signer.address,
    depositAddress: DEPOSIT,
    amount: AMOUNT,
    digestHex: assembled.digest_hex,
  },
});
report.gates.MPC_SIGNATURE_RECOVERY = validated.ok ? "PASS" : "FAIL";
report.gates.REAL_SIGNED_EVM_TRANSACTION = validated.ok ? "PASS" : "FAIL";
report.validate = validated;

const secret = createHash("sha256")
  .update(`j15-local-fork-${randomBytes(8).toString("hex")}`)
  .digest("hex");
process.env.NIO_TX_JOURNAL_SECRET = secret;
const runTag = randomBytes(3).toString("hex");
const journalPath = join(EVIDENCE, `j15-local-fork-journal-${runTag}.sqlite`);

const decision = deterministicTradeScenario({
  strategistSize: "100000000",
  fittedSize: AMOUNT,
  destination: DEPOSIT,
  assetIn: "USDC",
  mandateEpoch: 2,
});
decision.fitter.operation_id = `det-op-${AMOUNT}-${runTag}`;
decision.decision_hash = `det-${AMOUNT}-${runTag}`;

const adapters = {
  propose: async ({ amount_raw, operation_id }) => {
    if (String(amount_raw) !== AMOUNT) {
      return { ok: false, reason: "fitter_amount_mismatch" };
    }
    return {
      ok: true,
      operation_id,
      amount_raw: String(amount_raw),
      owner_approval_required: false,
    };
  },
  assembleSignedRaw: async () => ({
    ok: true,
    signed_raw: assembled.rawHex,
    rawHex: assembled.rawHex,
    nonce: lockedTx.nonce,
    digest_hex: assembled.digest_hex,
    recovered: assembled.recovered,
    label: "LOCAL_KEY_NOT_NEAR_MPC",
  }),
  broadcast: async ({ signed_raw, operation_id }) => {
    const send = await fork.eth("eth_sendRawTransaction", [signed_raw]);
    if (send.error) {
      throw new Error(send.error.message || "broadcast_failed");
    }
    // replay protection check
    const replay = await fork.eth("eth_sendRawTransaction", [signed_raw]);
    report.replay_rejected = Boolean(replay.error);
    return { tx_hash: send.result, operation_id };
  },
  settle: async ({ tx_hash }) => {
    const r = await fork.eth("eth_getTransactionReceipt", [tx_hash]);
    const receipt = r.result;
    return verifySettlementFromReceipt({
      receipt,
      expected: {
        mpc: signer.address,
        token: TOKEN,
        depositAddress: DEPOSIT,
        amount: AMOUNT,
      },
      allowSimulatorLabel: true,
    });
  },
  reconcile: async ({ independent_evidence, settle }) => {
    if (!independent_evidence) {
      return { ok: false, reason: "independent_evidence_required" };
    }
    if (!settle?.ok || settle.status !== "SETTLED") {
      return { ok: false, reason: "settle_not_verified" };
    }
    return {
      ok: true,
      status: "RECONCILED",
      evidence_hash: createHash("sha256")
        .update(String(settle.tx_hash))
        .digest("hex")
        .slice(0, 32),
      label: "LOCAL_FORK",
    };
  },
};

const trace = await runAutonomousExecution({
  decision,
  mandate: { trading_enabled: true },
  onChain: {
    paused: false,
    revoked: false,
    autonomous_trading: true,
    enforce_autonomous_on_agent: true,
    mandate_epoch: 2,
    limits: { max_trade_value: "5000000" },
  },
  quote: {
    amount_in: AMOUNT,
    destination: DEPOSIT,
    asset_in: "USDC",
    stale: false,
  },
  mode: EXEC_MODE.LOCAL_FORK,
  adapters,
  journalPath,
  simulateBroadcast: false,
  lockedTx,
});

report.execution_trace = {
  ok: trace.ok,
  label: trace.label,
  error: trace.error || null,
  steps: trace.steps.map((s) => {
    const k = Object.keys(s)[0];
    const v = s[k];
    return {
      [k]:
        typeof v === "object" && v
          ? {
              ok: v.ok,
              status: v.status,
              tx_hash: v.tx_hash,
              simulated: v.simulated,
              reason: v.reason,
              blockers: v.blockers,
              recovered: v.recovered || v.decoded?.recovered,
            }
          : v,
    };
  }),
  amount_raw: trace.plan?.amount_raw,
  rejected_strategist: trace.plan?.execution_binding?.rejected_strategist_size,
};

report.gates.REAL_TESTNET_OR_LOCAL_FORK_BROADCAST =
  trace.ok && report.replay_rejected ? "PASS_LOCAL_FORK" : "FAIL";
report.gates.INDEPENDENT_SETTLEMENT_VERIFICATION = trace.ok
  ? "PASS_LOCAL_FORK"
  : "FAIL";
report.gates.RECONCILIATION_PROOF = trace.ok ? "PASS_LOCAL_FORK" : "FAIL";

report.verdict = trace.ok ? "PASS_LOCAL_FORK" : "NO_GO";
report.finished_at = new Date().toISOString();

writeFileSync(
  join(EVIDENCE, "J15_LOCAL_FORK_SETTLEMENT_PROOF.json"),
  JSON.stringify(report, null, 2)
);
console.log(
  JSON.stringify(
    {
      verdict: report.verdict,
      gates: report.gates,
      amount_raw: report.execution_trace.amount_raw,
      replay_rejected: report.replay_rejected,
      evidence: join(EVIDENCE, "J15_LOCAL_FORK_SETTLEMENT_PROOF.json"),
    },
    null,
    2
  )
);
process.exit(trace.ok ? 0 : 1);
