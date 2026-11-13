#!/usr/bin/env node
/**
 * Checkpoint J7A — real MPC funding preparation (read-only).
 * NO transfers, NO escrow deposits, NO unpause, NO Ledger, NO broadcast.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveMainnetEvmAddress } from "../../packages/mainnet/mpc.mjs";
import {
  MAINNET_IDENTITIES,
  MAINNET_USDC,
} from "../../packages/mainnet/identities.mjs";
import {
  evmNativeBalance,
  evmErc20Balance,
} from "../../packages/mainnet/evmBalances.mjs";
import {
  ARBITRUM_NATIVE_USDC,
  ARBITRUM_USDC_E,
  ATTESTOR_GAS_LIMIT,
  ATTESTOR_MAX_GAS_PRICE_WEI,
  arbitrumChainId,
  readTokenMeta,
  nodeInterfaceL1Component,
  estimateErc20TransferGas,
  fetchArbitrumGasPrice,
  evaluateAttestorGasFit,
  recommendEthFunding,
  recommendUsdcFunding,
  defaultArbRpc,
} from "../../packages/mainnet/arbitrumFunding.mjs";
import { pickRpc, viewFunction } from "../../packages/networks/rpc.mjs";
import { MAINNET } from "../../packages/networks/profiles.mjs";
import { mainnetExecutionGates } from "../../packages/mainnet/safetyGates.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "docs/evidence");
mkdirSync(OUT, { recursive: true });

const ATTESTOR_PK =
  "ed25519:6oqnd5mBShyMGGHCgrJEEEPtgAEsXzJEPfARf7Fc2CG9";
/** Placeholder escrow-shaped destination for gas estimation only — not a live quote. */
const SAMPLE_ESCROW_FOR_GAS =
  "0xc660abc28579c3ef4993b6f3976a903e07ee937b";

async function main() {
  process.env.NIO_NETWORK = "mainnet";
  process.env.NEAR_NETWORK = "mainnet";
  const at = new Date().toISOString();
  const gates = mainnetExecutionGates(process.env);
  const arbRpc = defaultArbRpc();

  const derived = await deriveMainnetEvmAddress({
    policyContract: MAINNET_IDENTITIES.policy,
    portfolioId: MAINNET_IDENTITIES.portfolio_id,
  });
  const mpc = String(derived.evm_address).toLowerCase();
  const expected = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
  const mpcMatch = mpc === expected;

  const nearRpc = await pickRpc(MAINNET.near.rpcs);
  const [paused, autonomous, epoch, trusted, mpcSigner] = await Promise.all([
    viewFunction(nearRpc, MAINNET_IDENTITIES.policy, "get_paused", {}),
    viewFunction(
      nearRpc,
      MAINNET_IDENTITIES.policy,
      "get_autonomous_trading",
      {}
    ),
    viewFunction(nearRpc, MAINNET_IDENTITIES.policy, "get_mandate_epoch", {}),
    viewFunction(
      nearRpc,
      MAINNET_IDENTITIES.policy,
      "is_trusted_quote_signer",
      { public_key: ATTESTOR_PK }
    ),
    viewFunction(nearRpc, MAINNET_IDENTITIES.policy, "get_mpc_signer", {}),
  ]);

  const chain = await arbitrumChainId(arbRpc);
  const [ethBal, usdcBal, usdcEBal] = await Promise.all([
    evmNativeBalance(arbRpc, mpc),
    evmErc20Balance(arbRpc, ARBITRUM_NATIVE_USDC, mpc),
    evmErc20Balance(arbRpc, ARBITRUM_USDC_E, mpc),
  ]);
  const nativeMeta = await readTokenMeta(arbRpc, ARBITRUM_NATIVE_USDC);
  const bridgedMeta = await readTokenMeta(arbRpc, ARBITRUM_USDC_E);
  const nativeUsdcOk =
    nativeMeta.token === ARBITRUM_NATIVE_USDC &&
    nativeMeta.symbol === "USDC" &&
    nativeMeta.decimals === 6 &&
    nativeMeta.token !== ARBITRUM_USDC_E;

  const gasPrice = await fetchArbitrumGasPrice(arbRpc);
  const gasEst = await estimateErc20TransferGas(arbRpc, {
    from: mpc,
    token: ARBITRUM_NATIVE_USDC,
    to: SAMPLE_ESCROW_FOR_GAS,
    amountRaw: "1000000",
  });
  const l1 = gasEst.ok
    ? await nodeInterfaceL1Component(arbRpc, {
        to: ARBITRUM_NATIVE_USDC,
        data: gasEst.data,
        from: mpc,
      })
    : { ok: false, reason: "skipped_no_gas_est" };

  const fit =
    gasEst.ok && gasPrice.ok
      ? evaluateAttestorGasFit({
          liveGasPriceWei: gasPrice.wei,
          estimatedGas: gasEst.gas,
        })
      : {
          ok: false,
          executable_under_attestor_bounds: false,
          incompatibilities: [
            {
              code: "missing_gas_inputs",
              gasEst_ok: gasEst.ok,
              gasPrice_ok: gasPrice.ok,
            },
          ],
          live_case_fee_wei: null,
          attestor_ceiling_fee_wei: (
            ATTESTOR_GAS_LIMIT * ATTESTOR_MAX_GAS_PRICE_WEI
          ).toString(),
        };

  const ethRec = fit.live_case_fee_wei
    ? recommendEthFunding({
        liveCaseFeeWei: fit.live_case_fee_wei,
        attestorCeilingFeeWei: fit.attestor_ceiling_fee_wei,
      })
    : null;
  const usdcRec = recommendUsdcFunding();

  const ethNeed = ethRec ? BigInt(ethRec.recommended_wei) : null;
  const ethHave = ethBal.ok ? BigInt(ethBal.wei) : 0n;
  const usdcHave = usdcBal.ok ? BigInt(usdcBal.raw) : 0n;
  const ethDeficit =
    ethNeed != null && ethHave < ethNeed ? ethNeed - ethHave : 0n;
  const usdcDeficit =
    usdcHave < BigInt(usdcRec.recommended_units)
      ? BigInt(usdcRec.recommended_units) - usdcHave
      : 0n;

  const checklist = buildChecklist({
    mpc,
    ethRec,
    usdcRec,
    ethDeficit,
    usdcDeficit,
    nativeMeta,
  });

  const readyForJ7b =
    mpcMatch &&
    chain.ok &&
    nativeUsdcOk &&
    fit.executable_under_attestor_bounds &&
    paused === true &&
    autonomous === false &&
    trusted === true &&
    mpcSigner === "v1.signer" &&
    !gates.funded_trading &&
    !gates.mainnet_broadcast_enabled &&
    ethRec != null;

  const evidence = {
    checkpoint: "J7A",
    at,
    safety: {
      transfers_executed: false,
      evm_funding_auto: false,
      escrow_deposit: false,
      unpause: false,
      autonomous: false,
      mainnet_broadcast: false,
      ledger_signed: false,
      contract_upgrade: false,
      reused_old_quote: false,
      secrets_logged: false,
    },
    policy: {
      paused: Boolean(paused),
      autonomous_trading: Boolean(autonomous),
      mandate_epoch: epoch,
      is_trusted_quote_signer: trusted,
      trusted_attestor: ATTESTOR_PK,
      mpc_signer: mpcSigner,
    },
    gates: {
      funded_trading: gates.funded_trading,
      mainnet_broadcast_enabled: gates.mainnet_broadcast_enabled,
      autonomous_execution_enabled: gates.autonomous_execution_enabled,
    },
    mpc_derivation: {
      predecessor: derived.predecessor,
      path: derived.path,
      signer: derived.signer,
      domain_id: derived.domain_id,
      evm_address: mpc,
      expected_identity: expected,
      match: mpcMatch,
      status: derived.status,
      near_secp_key_present: Boolean(derived.near_secp_key),
    },
    arbitrum: {
      rpc_host: new URL(arbRpc).host,
      chain_id_check: chain,
      balances: {
        address: mpc,
        native_eth_wei: ethBal.ok ? ethBal.wei : null,
        native_eth: ethBal.ok ? ethBal.ether : null,
        native_usdc_contract: ARBITRUM_NATIVE_USDC,
        native_usdc_raw: usdcBal.ok ? usdcBal.raw : null,
        native_usdc: usdcBal.ok ? usdcBal.ui : null,
        usdc_e_contract: ARBITRUM_USDC_E,
        usdc_e_raw: usdcEBal.ok ? usdcEBal.raw : null,
        usdc_e: usdcEBal.ok ? usdcEBal.ui : null,
      },
      native_usdc_meta: nativeMeta,
      bridged_usdc_e_meta: bridgedMeta,
      native_usdc_verified: nativeUsdcOk,
      gas: {
        eth_gasPrice_wei: gasPrice.ok ? gasPrice.wei : null,
        eth_gasPrice_gwei: gasPrice.ok ? gasPrice.gwei : null,
        transfer_estimate: gasEst,
        node_interface_l1: l1,
        attestor_bounds: {
          max_gas_price_wei: ATTESTOR_MAX_GAS_PRICE_WEI.toString(),
          gas_limit: ATTESTOR_GAS_LIMIT.toString(),
        },
        fit,
      },
    },
    funding_recommendation: {
      eth: ethRec,
      eth_have_wei: ethHave.toString(),
      eth_deficit_wei: ethDeficit.toString(),
      usdc: usdcRec,
      usdc_have_raw: usdcHave.toString(),
      usdc_deficit_raw: usdcDeficit.toString(),
      instructions: {
        A_eth: {
          chain: "Arbitrum One (42161)",
          asset: "native ETH",
          to: mpc,
          amount_eth: ethRec?.recommended_eth ?? null,
          amount_wei: ethRec?.recommended_wei ?? null,
        },
        B_usdc: {
          chain: "Arbitrum One (42161)",
          asset: "native USDC only",
          token: ARBITRUM_NATIVE_USDC,
          not_token: ARBITRUM_USDC_E,
          to: mpc,
          amount_usdc: usdcRec.recommended_usdc,
          amount_raw: usdcRec.recommended_units,
        },
      },
    },
    j7b_operator_checklist: checklist,
    readiness_j7b: readyForJ7b
      ? "READY_FOR_J7B_EXTERNAL_WALLET_FUNDING"
      : "NOT_READY",
    next_approved_action: readyForJ7b
      ? "J7B: operator sends Arbitrum ETH then native USDC from an external wallet to the verified MPC address; verify receipts before any further step"
      : "Fix gas/derivation/policy blockers before any funding",
  };

  writeFileSync(
    join(OUT, "MAINNET_CHECKPOINT_J7A.json"),
    JSON.stringify(evidence, null, 2)
  );
  writeFileSync(join(OUT, "MAINNET_CHECKPOINT_J7A.md"), renderMd(evidence));

  console.log(
    JSON.stringify(
      {
        mpc,
        mpc_match: mpcMatch,
        eth_bal: ethBal.ok ? ethBal.ether : null,
        usdc_bal: usdcBal.ok ? usdcBal.ui : null,
        gas_price_gwei: gasPrice.ok ? gasPrice.gwei : null,
        gas_estimate: gasEst.ok ? gasEst.gas : null,
        eth_recommend: ethRec?.recommended_eth,
        usdc_recommend: usdcRec.recommended_usdc,
        gas_ok: fit.executable_under_attestor_bounds,
        incompatibilities: fit.incompatibilities,
        readiness: evidence.readiness_j7b,
      },
      null,
      2
    )
  );
}

function buildChecklist({
  mpc,
  ethRec,
  usdcRec,
  ethDeficit,
  usdcDeficit,
  nativeMeta,
}) {
  return {
    title: "J7B operator transfer checklist (external wallet only)",
    preconditions: [
      "Confirm MetaMask/Rabby network = Arbitrum One, chainId 42161",
      `Confirm destination = ${mpc} (re-derived MPC)`,
      `Confirm USDC token contract = ${ARBITRUM_NATIVE_USDC} (symbol ${nativeMeta.symbol}, decimals ${nativeMeta.decimals})`,
      `Reject USDC.e ${ARBITRUM_USDC_E}`,
      "Do not use NIO broadcast, agent key, attestor key, or Ledger for funding",
      "Keep policy paused=true; do not unpause; do not deposit to 1Click escrow yet",
    ],
    steps: [
      {
        id: "A",
        action: "Send native ETH",
        to: mpc,
        amount_wei: ethRec?.recommended_wei,
        amount_eth: ethRec?.recommended_eth,
        deficit_wei: ethDeficit.toString(),
        verify: [
          "Wait for receipt status == 0x1 (success)",
          "receipt.chainId / network == 42161",
          `tx.to == ${mpc} OR value recipient == ${mpc}`,
          "asset == native ETH (no token contract)",
          `post eth_getBalance(MPC) - pre >= recommended_wei (or deficit covered)`,
        ],
      },
      {
        id: "B",
        action: "Send native USDC ERC-20 transfer",
        to: mpc,
        token: ARBITRUM_NATIVE_USDC,
        amount_raw: usdcRec.recommended_units,
        amount_usdc: usdcRec.recommended_usdc,
        deficit_raw: usdcDeficit.toString(),
        verify: [
          "Wait for receipt status == 0x1",
          "network chainId == 42161",
          `receipt.to / logs address == ${ARBITRUM_NATIVE_USDC}`,
          `Transfer topic to == ${mpc}`,
          "Confirm NOT USDC.e contract",
          `post balanceOf(MPC) - pre >= ${usdcRec.recommended_units} (or deficit covered)`,
        ],
      },
    ],
    success_gate:
      "Funding is successful ONLY after both receipt checks and positive balance deltas. Never mark success from wallet UI alone.",
    stop_after:
      "Stop after verified balances. No escrow deposit, no unpause, no trade.",
  };
}

function renderMd(e) {
  const b = e.arbitrum.balances;
  const g = e.arbitrum.gas;
  const f = e.funding_recommendation;
  const pre = e.j7b_operator_checklist.preconditions
    .map((p) => "- " + p)
    .join("\n");
  const steps = e.j7b_operator_checklist.steps
    .map((s) => {
      const checks = s.verify.map((v) => "- [ ] " + v).join("\n");
      return "### Step " + s.id + ": " + s.action + "\n" + checks;
    })
    .join("\n\n");
  return [
    "# Checkpoint J7A - Real MPC funding preparation",
    "",
    "**NO transfers / NO auto-funding / NO escrow / NO unpause / NO Ledger / NO broadcast**",
    "",
    "## 1. Verified MPC address",
    "",
    "| Item | Value |",
    "|------|-------|",
    "| Derived | `" + e.mpc_derivation.evm_address + "` |",
    "| Identity match | **" + e.mpc_derivation.match + "** |",
    "| Path | `" + e.mpc_derivation.path + "` |",
    "| Signer | `" + e.mpc_derivation.signer + "` |",
    "| Policy | paused=" +
      e.policy.paused +
      " autonomous=" +
      e.policy.autonomous_trading +
      " epoch=" +
      e.policy.mandate_epoch +
      " trusted=" +
      e.policy.is_trusted_quote_signer +
      " |",
    "",
    "## 2. Current Arbitrum balances",
    "",
    "| Asset | Balance |",
    "|-------|---------|",
    "| ETH | " + b.native_eth + " wei=" + b.native_eth_wei + " |",
    "| Native USDC (`" +
      b.native_usdc_contract +
      "`) | " +
      b.native_usdc +
      " raw=" +
      b.native_usdc_raw +
      " |",
    "| USDC.e (`" +
      b.usdc_e_contract +
      "`) | " +
      b.usdc_e +
      " (must stay unused) |",
    "| Chain ID check | " +
      JSON.stringify(e.arbitrum.chain_id_check) +
      " |",
    "| Native USDC meta | " +
      e.arbitrum.native_usdc_meta.symbol +
      " / " +
      e.arbitrum.native_usdc_meta.name +
      " / decimals=" +
      e.arbitrum.native_usdc_meta.decimals +
      " verified=" +
      e.arbitrum.native_usdc_verified +
      " |",
    "",
    "## 3. Gas",
    "",
    "| Item | Value |",
    "|------|-------|",
    "| eth_gasPrice | " +
      g.eth_gasPrice_wei +
      " wei (" +
      g.eth_gasPrice_gwei +
      " gwei) |",
    "| Transfer gas estimate | " +
      g.transfer_estimate.gas +
      " (" +
      g.transfer_estimate.method +
      ") |",
    "| L1 component gas | " +
      g.node_interface_l1.gas_estimate_for_l1 +
      " fee_wei=" +
      g.node_interface_l1.l1_component_fee_wei +
      " |",
    "| Attestor max_gas_price | " +
      g.attestor_bounds.max_gas_price_wei +
      " |",
    "| Attestor gas_limit | " + g.attestor_bounds.gas_limit + " |",
    "| Executable under bounds | **" +
      g.fit.executable_under_attestor_bounds +
      "** |",
    "| Incompatibilities | " +
      JSON.stringify(g.fit.incompatibilities) +
      " |",
    "",
    "## 4-5. Funding recommendation",
    "",
    "| Asset | Recommended | Have | Deficit |",
    "|-------|-------------|------|---------|",
    "| ETH | " +
      f.eth?.recommended_eth +
      " ETH (" +
      f.eth?.recommended_wei +
      " wei) | " +
      f.eth_have_wei +
      " wei | " +
      f.eth_deficit_wei +
      " wei |",
    "| Native USDC | " +
      f.usdc.recommended_usdc +
      " USDC (" +
      f.usdc.recommended_units +
      ") | " +
      f.usdc_have_raw +
      " | " +
      f.usdc_deficit_raw +
      " |",
    "",
    "### A. ETH to MPC",
    "- Chain: Arbitrum One (42161)",
    "- To: `" + e.mpc_derivation.evm_address + "`",
    "- Amount: **" + f.eth?.recommended_eth + " ETH**",
    "",
    "### B. Native USDC to MPC",
    "- Chain: Arbitrum One (42161)",
    "- Token: `" + MAINNET_USDC.arbitrum + "` (NOT USDC.e)",
    "- To: `" + e.mpc_derivation.evm_address + "`",
    "- Amount: **" + f.usdc.recommended_usdc + " USDC**",
    "",
    "## J7B checklist",
    "",
    pre,
    "",
    steps,
    "",
    "**" + e.j7b_operator_checklist.success_gate + "**",
    "",
    "## Readiness",
    "",
    "**" + e.readiness_j7b + "**",
    "",
    "Next approved action: " + e.next_approved_action,
    "",
  ].join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
