#!/usr/bin/env node
/**
 * Checkpoint J6A — prepare mainnet attestor + Ledger registration preview.
 * Does NOT sign/broadcast Ledger registration. Does NOT deposit or fund.
 */
import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { productionDryQuote } from "../../packages/mainnet/intents.mjs";
import {
  attestTidepoolQuote,
  attestationMessageV2,
  publicKeyEd25519,
} from "../../packages/intents-codec/quote-auth.mjs";
import { evaluateLiveMinOutAgainstPolicy } from "../../packages/mainnet/quotePath.mjs";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";
import { pickRpc, viewFunction } from "../../packages/networks/rpc.mjs";
import { MAINNET } from "../../packages/networks/profiles.mjs";
import { mainnetExecutionGates } from "../../packages/mainnet/safetyGates.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "docs/evidence");
mkdirSync(OUT, { recursive: true });

const MPC = MAINNET_IDENTITIES.mpc_evm_address;
const ARB_USDC =
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const BASE_USDC =
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const ARB_TOKEN = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const CHAIN_ID = 42161;
const GAS_LIMIT = "250000";
const MAX_GAS_PRICE = "100000000"; // 0.1 gwei L2 ceiling for attestation

function loadAttestor() {
  const latest = join(
    homedir(),
    ".nio-secure",
    "mainnet-attestor",
    "LATEST_ATTESTOR_PATH.txt"
  );
  if (!existsSync(latest)) throw new Error("attestor_not_generated");
  const seedPath = readFileSync(latest, "utf8").trim();
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  const sk = Buffer.from(seed.secretKey64, "base64");
  const pk = publicKeyEd25519(sk);
  if (pk !== seed.publicKey) throw new Error("attestor_key_mismatch");
  return { publicKey: pk, secretKey64: sk, path: seedPath };
}

function sanitizeAttestation(result) {
  if (!result) return null;
  return {
    ok: result.ok,
    reason: result.reason || null,
    checks: result.checks,
    attestation: result.attestation,
    attestation_id: result.attestation_id,
    publicKey: result.publicKey,
    trust_model: result.trust_model,
    signature_present: Boolean(result.signature),
    signature_prefix: result.signature
      ? String(result.signature).slice(0, 20) + "…"
      : null,
    message_prefix: result.message_utf8
      ? result.message_utf8.slice(0, 80) + "…"
      : null,
  };
}

async function main() {
  process.env.NIO_NETWORK = "mainnet";
  process.env.NEAR_NETWORK = "mainnet";
  const at = new Date().toISOString();
  const attestor = loadAttestor();
  const gates = mainnetExecutionGates(process.env);

  const rpc = await pickRpc(MAINNET.near.rpcs);
  const [paused, autonomous, epoch, limits, alreadyTrusted] = await Promise.all([
    viewFunction(rpc, MAINNET_IDENTITIES.policy, "get_paused", {}),
    viewFunction(rpc, MAINNET_IDENTITIES.policy, "get_autonomous_trading", {}),
    viewFunction(rpc, MAINNET_IDENTITIES.policy, "get_mandate_epoch", {}),
    viewFunction(rpc, MAINNET_IDENTITIES.policy, "get_limits", {}),
    viewFunction(rpc, MAINNET_IDENTITIES.policy, "is_trusted_quote_signer", {
      public_key: attestor.publicKey,
    }).catch(() => null),
  ]);

  // Fresh non-dry quote (do not reuse J5.2)
  const prev = process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE;
  process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE = "1";
  let quoteResult;
  try {
    quoteResult = await productionDryQuote(
      {
        originAsset: ARB_USDC,
        destinationAsset: BASE_USDC,
        amount: "1000000",
        slippageTolerance: 25,
        recipient: MPC,
        refundTo: MPC,
      },
      { allowFundedQuote: true }
    );
  } finally {
    if (prev === undefined) delete process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE;
    else process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE = prev;
  }

  let attestResult = { ok: false, reason: "quote_blocked" };
  let localSigOk = false;
  let rustFormatOk = false;
  let negativeExpiredBlocked = false;
  let negativeMutatedBlocked = false;

  const policyOk =
    quoteResult?.ok &&
    quoteResult.one_click_verify?.ok &&
    quoteResult.one_click_verify?.escrow_in_signed_hash &&
    quoteResult.deposit_address;

  let floorEval = null;
  if (quoteResult?.ok) {
    floorEval = evaluateLiveMinOutAgainstPolicy({
      amountIn: quoteResult.amount_in,
      minAmountOut: quoteResult.min_amount_out || quoteResult.quote?.minAmountOut,
      maxSlippageBps: Number(limits?.max_slippage_bps || 100),
      label: "j6a_fresh_nondry",
    });
  }

  if (policyOk && floorEval?.result === "PASS") {
    attestResult = attestTidepoolQuote({
      quoteResponse: quoteResult.one_click_response,
      agentRequest: {
        originAsset: ARB_USDC,
        destinationAsset: BASE_USDC,
        amount: "1000000",
        depositType: "ORIGIN_CHAIN",
        recipient: MPC,
        refundTo: MPC,
      },
      tokenContract: ARB_TOKEN,
      chainId: CHAIN_ID,
      maxGasPrice: MAX_GAS_PRICE,
      gasLimit: GAS_LIMIT,
      secretKey64: attestor.secretKey64,
      productionMode: true,
      mainnetFundedPath: true,
      policyLimits: limits,
      allowedDestinations: limits?.allowed_destinations || [MPC, MAINNET_IDENTITIES.owner],
      allowedAssets: limits?.allowed_assets || [ARB_USDC, BASE_USDC],
      allowedChains: limits?.allowed_chains || ["eip155:42161"],
    });

    if (attestResult.ok) {
      const msg = Buffer.from(attestResult.message_utf8, "utf8");
      rustFormatOk = attestResult.message_utf8.startsWith("QUOTE_AUTH_V2\n");
      const sigBody = attestResult.signature.replace(/^ed25519:/, "");
      localSigOk = nacl.sign.detached.verify(
        msg,
        bs58.decode(sigBody),
        nacl.sign.keyPair.fromSecretKey(attestor.secretKey64).publicKey
      );

      // Negative: expired deadline cannot attest
      const expired = structuredClone(quoteResult.one_click_response);
      expired.quote.deadline = new Date(Date.now() - 120_000).toISOString();
      // Mutating deadline invalidates 1Click sig → fail closed
      const expAttest = attestTidepoolQuote({
        quoteResponse: expired,
        agentRequest: {
          originAsset: ARB_USDC,
          destinationAsset: BASE_USDC,
          amount: "1000000",
          depositType: "ORIGIN_CHAIN",
          recipient: MPC,
          refundTo: MPC,
        },
        tokenContract: ARB_TOKEN,
        chainId: CHAIN_ID,
        maxGasPrice: MAX_GAS_PRICE,
        gasLimit: GAS_LIMIT,
        secretKey64: attestor.secretKey64,
        productionMode: true,
      });
      negativeExpiredBlocked = expAttest.ok === false;

      const mutated = structuredClone(quoteResult.one_click_response);
      mutated.quote.depositAddress =
        "0x0000000000000000000000000000000000000bad";
      const mutAttest = attestTidepoolQuote({
        quoteResponse: mutated,
        agentRequest: {
          originAsset: ARB_USDC,
          destinationAsset: BASE_USDC,
          amount: "1000000",
          depositType: "ORIGIN_CHAIN",
          recipient: MPC,
          refundTo: MPC,
        },
        tokenContract: ARB_TOKEN,
        chainId: CHAIN_ID,
        maxGasPrice: MAX_GAS_PRICE,
        gasLimit: GAS_LIMIT,
        secretKey64: attestor.secretKey64,
        productionMode: true,
      });
      negativeMutatedBlocked = mutAttest.ok === false;
    }
  } else {
    attestResult = {
      ok: false,
      reason: !quoteResult?.ok
        ? quoteResult?.reason || "quote_failed"
        : !quoteResult.one_click_verify?.ok
          ? `verify:${quoteResult.one_click_verify?.reason}`
          : floorEval?.result !== "PASS"
            ? `policy_floor:${floorEval?.result}`
            : "escrow_or_policy_blocked",
      checks: [],
    };
  }

  const argsPath = join(
    homedir(),
    ".nio-secure",
    "mainnet-attestor",
    "set_trusted_quote_signer.args.json"
  );
  writeFileSync(
    argsPath,
    JSON.stringify({ public_key: attestor.publicKey }, null, 2)
  );
  const removeArgsPath = join(
    homedir(),
    ".nio-secure",
    "mainnet-attestor",
    "remove_trusted_quote_signer.args.json"
  );
  writeFileSync(
    removeArgsPath,
    JSON.stringify({ public_key: attestor.publicKey }, null, 2)
  );

  const nearCli =
    process.env.NIO_NEAR_CLI ||
    join(
      homedir(),
      "bin",
      "near-cli-rs",
      "near-cli-rs-x86_64-pc-windows-msvc",
      "near.exe"
    );
  const HD = "m/44'/397'/0'/0'/1'";

  const ledgerRegisterCmd = `# DO NOT RUN until J6B approved
$near = "${nearCli}"
$HD = "${HD}"
$ARGS = "${argsPath}"

& $near contract call-function as-transaction policy.nishanthb.near set_trusted_quote_signer file-args $ARGS \`
  prepaid-gas '100.0 Tgas' \`
  attached-deposit '0 NEAR' \`
  sign-as nishanthb.near \`
  network-config mainnet \`
  sign-with-ledger --seed-phrase-hd-path $HD \`
  usb
`;

  const ledgerRemoveCmd = `# EMERGENCY remove — only if needed
$near = "${nearCli}"
$HD = "${HD}"
$ARGS = "${removeArgsPath}"

& $near contract call-function as-transaction policy.nishanthb.near remove_trusted_quote_signer file-args $ARGS \`
  prepaid-gas '100.0 Tgas' \`
  attached-deposit '0 NEAR' \`
  sign-as nishanthb.near \`
  network-config mainnet \`
  sign-with-ledger --seed-phrase-hd-path $HD \`
  usb
`;

  const viewCmd = `& "${nearCli}" contract call-function as-read-only policy.nishanthb.near is_trusted_quote_signer json-args "{\\"public_key\\":\\"${attestor.publicKey}\\"}" network-config mainnet now`;

  const evidence = {
    checkpoint: "J6A",
    at,
    node: process.version,
    safety: {
      ledger_signed: false,
      mainnet_mutations: false,
      evm_funding: false,
      escrow_deposit: false,
      unpause: false,
      autonomous: false,
      broadcast: false,
      secrets_in_evidence: false,
    },
    attestor: {
      public_key: attestor.publicKey,
      secret_path: attestor.path,
      // never include secret
    },
    policy: {
      paused: Boolean(paused),
      autonomous_trading: Boolean(autonomous),
      mandate_epoch: epoch,
      max_trade_value: limits?.max_trade_value,
      max_slippage_bps: limits?.max_slippage_bps,
      max_gas_budget: limits?.max_gas_budget,
      token_scope: limits?.token_scope,
    },
    gates: {
      funded_trading: gates.funded_trading,
      mainnet_broadcast_enabled: gates.mainnet_broadcast_enabled,
      autonomous_execution_enabled: gates.autonomous_execution_enabled,
    },
    is_trusted_quote_signer_before: alreadyTrusted,
    fresh_nondry_quote: {
      ok: Boolean(quoteResult?.ok),
      reason: quoteResult?.reason || null,
      detail: quoteResult?.detail || null,
      dry: quoteResult?.dry === false ? false : quoteResult?.dry,
      verify: quoteResult?.one_click_verify || null,
      amount_in: quoteResult?.amount_in || null,
      amount_out: quoteResult?.amount_out || null,
      min_amount_out: quoteResult?.min_amount_out || null,
      deposit_address: quoteResult?.deposit_address || null,
      correlation_id: quoteResult?.correlation_id || null,
      timestamp: quoteResult?.timestamp || null,
      quote_hash: quoteResult?.one_click_verify?.quote_hash || null,
      floor_eval: floorEval,
      values_altered: false,
      reused_j5_2_quote: false,
    },
    attestation: {
      result: attestResult.ok ? "PASS" : "BLOCKED",
      detail: sanitizeAttestation(attestResult),
      local_signature_verify: localSigOk,
      rust_message_format_ok: rustFormatOk,
      negative_expired_blocked: negativeExpiredBlocked,
      negative_mutated_deposit_blocked: negativeMutatedBlocked,
    },
    ledger_preview: {
      signer: "nishanthb.near",
      receiver: "policy.nishanthb.near",
      hd_path: HD,
      method: "set_trusted_quote_signer",
      args_file: argsPath,
      register_command: ledgerRegisterCmd,
      remove_command: ledgerRemoveCmd,
      view_command: viewCmd,
      executed: false,
    },
    readiness_j6b:
      attestResult.ok &&
      localSigOk &&
      rustFormatOk &&
      alreadyTrusted === false &&
      paused === true &&
      !gates.funded_trading &&
      !gates.mainnet_broadcast_enabled
        ? "READY_FOR_J6B_LEDGER_REGISTRATION_APPROVAL"
        : "NOT_READY",
  };

  writeFileSync(
    join(OUT, "MAINNET_CHECKPOINT_J6A.json"),
    JSON.stringify(evidence, null, 2)
  );
  writeFileSync(
    join(OUT, "MAINNET_CHECKPOINT_J6A.md"),
    renderMd(evidence)
  );

  console.log(
    JSON.stringify(
      {
        public_key: attestor.publicKey,
        secret_path: attestor.path,
        attestation: evidence.attestation.result,
        is_trusted_before: alreadyTrusted,
        readiness: evidence.readiness_j6b,
        local_sig: localSigOk,
        floor: floorEval?.result,
      },
      null,
      2
    )
  );
}

function renderMd(e) {
  const q = e.fresh_nondry_quote || {};
  const a = e.attestation?.detail?.attestation || {};
  return `# Checkpoint J6A — Prepare trusted mainnet attestor

**NO Ledger sign / NO on-chain mutation / NO deposit / NO funding**

## Attestor (public only)

| Item | Value |
|------|-------|
| Public key | \`${e.attestor.public_key}\` |
| Secret path | \`${e.attestor.secret_path}\` (contents never logged) |
| is_trusted_quote_signer (before) | **${JSON.stringify(e.is_trusted_quote_signer_before)}** |

## Policy / gates (unchanged)

| Gate | Value |
|------|-------|
| paused | ${e.policy.paused} |
| autonomous_trading | ${e.policy.autonomous_trading} |
| mandate_epoch | ${e.policy.mandate_epoch} |
| funded_trading | ${e.gates.funded_trading} |
| mainnet_broadcast_enabled | ${e.gates.mainnet_broadcast_enabled} |

## Fresh quote → attestation

**${e.attestation.result}** · local sig verify=${e.attestation.local_signature_verify} · Rust QUOTE_AUTH_V2 format=${e.attestation.rust_message_format_ok}

| Field | Value |
|-------|-------|
| route | Arb USDC → Base USDC |
| amount_in | ${q.amount_in} |
| amount_out | ${q.amount_out} |
| min_amount_out | ${q.min_amount_out} |
| policy_floor | ${q.floor_eval?.policy_floor} |
| quote_hash | \`${q.verify?.quote_hash || a.quote_hash || ""}\` |
| deposit | \`${q.deposit_address || ""}\` |
| escrow_in_signed_hash | ${q.verify?.escrow_in_signed_hash} |
| recipient/refund | \`${a.recipient || ""}\` |

Negatives: expired BLOCKED=${e.attestation.negative_expired_blocked} · mutated deposit BLOCKED=${e.attestation.negative_mutated_deposit_blocked}

## Ledger registration (DO NOT RUN until J6B)

\`\`\`powershell
${e.ledger_preview.register_command}
\`\`\`

## Emergency removal

\`\`\`powershell
${e.ledger_preview.remove_command}
\`\`\`

## Readiness for J6B

**${e.readiness_j6b}**
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
