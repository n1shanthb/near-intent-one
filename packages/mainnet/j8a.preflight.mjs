/**
 * J8A — first real mainnet trade preflight (read-only / local simulation).
 * Never calls propose_quoted_evm_transfer, request_signature, eth_sendRawTransaction,
 * unpause, or escrow deposit.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  attestTidepoolQuote,
  attestationMessageV2,
  publicKeyEd25519,
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
  serializeSignedTx,
} from "../intents-codec/quote-auth.mjs";
import { productionDryQuote } from "./intents.mjs";
import {
  evaluateLiveMinOutAgainstPolicy,
  simulatePolicyChecks,
  buildErc20TxParams,
} from "./quotePath.mjs";
import {
  MAINNET_IDENTITIES,
  MAINNET_USDC,
  MAINNET_EVM_RPCS,
} from "./identities.mjs";
import {
  evmNativeBalance,
  evmErc20Balance,
} from "./evmBalances.mjs";
import {
  ARBITRUM_NATIVE_USDC,
  ARBITRUM_CHAIN_ID,
  ATTESTOR_MAX_GAS_PRICE_WEI,
  ATTESTOR_GAS_LIMIT,
  arbitrumChainId,
  estimateErc20TransferGas,
  fetchArbitrumGasPrice,
  nodeInterfaceL1Component,
} from "./arbitrumFunding.mjs";
import { pickRpc, viewFunction } from "../networks/rpc.mjs";
import { MAINNET } from "../networks/profiles.mjs";
import {
  mainnetExecutionGates,
  guardedMainnetSubmit,
} from "./safetyGates.mjs";

export const ATTESTOR_PK =
  "ed25519:6oqnd5mBShyMGGHCgrJEEEPtgAEsXzJEPfARf7Fc2CG9";
export const MPC = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
export const ARB_USDC_ASSET =
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
export const BASE_USDC_ASSET =
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const FUNDING_ETH_TX =
  "0x08d6a912d3b250f20b0c5d3dd6c5b724f0a060405b028fcc3a93159e5fba9ea4";
export const FUNDING_USDC_TX =
  "0x5a524ab39087965ac18c5b46c23287bb5eeef121ffa7d164ae2aa10dcd808e1d";

async function ethRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

function loadAttestorSecret() {
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
  if (pk !== ATTESTOR_PK) throw new Error("attestor_pk_not_registered_key");
  return { publicKey: pk, secretKey64: sk, path: seedPath };
}

export function chooseGasParams({ liveGasPriceWei, estimatedGas, ethBalanceWei }) {
  const live = BigInt(liveGasPriceWei);
  const est = BigInt(estimatedGas);
  // Headroom on L2 gas limit; keep within historical attestor ceiling family.
  let gasLimit = est + est / 2n; // +50%
  if (gasLimit < 100_000n) gasLimit = 100_000n;
  if (gasLimit > ATTESTOR_GAS_LIMIT) gasLimit = ATTESTOR_GAS_LIMIT;

  // Proposed price: 1.5x live, never below live, never above attestor max.
  let gasPrice = (live * 150n) / 100n;
  if (gasPrice < live) gasPrice = live;
  if (gasPrice > ATTESTOR_MAX_GAS_PRICE_WEI) {
    gasPrice = ATTESTOR_MAX_GAS_PRICE_WEI;
  }
  const maxGasPrice = ATTESTOR_MAX_GAS_PRICE_WEI;
  const needLive = gasPrice * gasLimit;
  const needCeiling = maxGasPrice * gasLimit;
  const bal = BigInt(ethBalanceWei);
  const blockers = [];
  if (live > maxGasPrice) {
    blockers.push({
      code: "live_gas_price_exceeds_attestor_max",
      live: live.toString(),
      max: maxGasPrice.toString(),
    });
  }
  if (est > ATTESTOR_GAS_LIMIT) {
    blockers.push({
      code: "estimate_exceeds_attestor_gas_limit",
      estimated: est.toString(),
      limit: ATTESTOR_GAS_LIMIT.toString(),
    });
  }
  if (bal < needLive) {
    blockers.push({
      code: "insufficient_eth_for_proposed_gas",
      have: bal.toString(),
      need: needLive.toString(),
    });
  }
  // Advisory only: gate-k Sepolia 1 gwei floor (1e9) exceeds attestor max (1e8).
  // Mainnet Arb path must never apply that floor — not a live-condition failure.
  const sepoliaFloor = 1_000_000_000n;
  const warnings = [];
  if (sepoliaFloor > maxGasPrice) {
    warnings.push({
      code: "do_not_apply_sepolia_1gwei_floor",
      note: "gate-k 1 gwei floor is incompatible with attestor max_gas_price on Arbitrum; J8B must use live*1.5 capped at attestor max",
    });
  }
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    gas_limit: gasLimit.toString(),
    gas_price: gasPrice.toString(),
    max_gas_price: maxGasPrice.toString(),
    eth_need_at_proposed: needLive.toString(),
    eth_need_at_ceiling: needCeiling.toString(),
    eth_balance: bal.toString(),
    eth_covers_proposed: bal >= needLive,
    eth_covers_ceiling: bal >= needCeiling,
  };
}

/**
 * Full local preflight. Mutates nothing on-chain.
 */
export async function runJ8aPreflight(opts = {}) {
  process.env.NIO_NETWORK = "mainnet";
  process.env.NEAR_NETWORK = "mainnet";
  const at = new Date().toISOString();
  const gates = mainnetExecutionGates(process.env);
  const arbRpc = opts.arbRpc || MAINNET_EVM_RPCS.arbitrum;
  const baseRpc = opts.baseRpc || MAINNET_EVM_RPCS.base;
  const mutations = {
    propose_quoted_evm_transfer: false,
    request_signature: false,
    eth_sendRawTransaction: false,
    unpause: false,
    escrow_deposit: false,
    ledger_sign: false,
  };

  // --- balances + receipts ---
  const chain = await arbitrumChainId(arbRpc);
  const [arbEth, arbUsdc, baseEth, baseUsdcFixed, nonceJ, gasPriceJ] =
    await Promise.all([
      evmNativeBalance(arbRpc, MPC),
      evmErc20Balance(arbRpc, ARBITRUM_NATIVE_USDC, MPC),
      evmNativeBalance(baseRpc, MPC),
      evmErc20Balance(baseRpc, MAINNET_USDC.base, MPC),
      ethRpc(arbRpc, "eth_getTransactionCount", [MPC, "pending"]),
      fetchArbitrumGasPrice(arbRpc),
    ]);

  const ethReceipt = await ethRpc(arbRpc, "eth_getTransactionReceipt", [
    FUNDING_ETH_TX,
  ]);
  const usdcReceipt = await ethRpc(arbRpc, "eth_getTransactionReceipt", [
    FUNDING_USDC_TX,
  ]);
  const ethRcptOk =
    ethReceipt.result?.status === "0x1" &&
    String(ethReceipt.result?.to || "").toLowerCase() === MPC;
  const usdcRcptOk =
    usdcReceipt.result?.status === "0x1" &&
    String(usdcReceipt.result?.to || "").toLowerCase() ===
      ARBITRUM_NATIVE_USDC.toLowerCase();

  const nonce = Number(BigInt(nonceJ.result || "0x0"));

  // --- policy ---
  const nearRpc = await pickRpc(MAINNET.near.rpcs);
  const policy = MAINNET_IDENTITIES.policy;
  const [mandate, trusted, reserved] = await Promise.all([
    viewFunction(nearRpc, policy, "get_gate_j_mandate", {}),
    viewFunction(nearRpc, policy, "is_trusted_quote_signer", {
      public_key: ATTESTOR_PK,
    }),
    viewFunction(nearRpc, policy, "get_reserved_pending_exposure", {}),
  ]);
  const limits = mandate.limits;

  // --- fresh quote ---
  const prev = process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE;
  process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE = "1";
  let quoteResult;
  try {
    quoteResult = await productionDryQuote(
      {
        originAsset: ARB_USDC_ASSET,
        destinationAsset: BASE_USDC_ASSET,
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

  const floorEval = quoteResult?.ok
    ? evaluateLiveMinOutAgainstPolicy({
        amountIn: quoteResult.amount_in,
        minAmountOut:
          quoteResult.min_amount_out || quoteResult.quote?.minAmountOut,
        maxSlippageBps: Number(limits.max_slippage_bps || 100),
        label: "j8a_fresh_nondry",
      })
    : null;

  const quoteOk =
    quoteResult?.ok &&
    quoteResult.one_click_verify?.ok &&
    quoteResult.one_click_verify?.escrow_in_signed_hash &&
    quoteResult.deposit_address &&
    floorEval?.result === "PASS";

  // --- gas estimate from funded MPC ---
  const depositForGas =
    quoteOk
      ? quoteResult.deposit_address
      : "0xc660abc28579c3ef4993b6f3976a903e07ee937b";
  const gasEst = await estimateErc20TransferGas(arbRpc, {
    from: MPC,
    token: ARBITRUM_NATIVE_USDC,
    to: depositForGas,
    amountRaw: "1000000",
  });
  const l1 = gasEst.ok
    ? await nodeInterfaceL1Component(arbRpc, {
        to: ARBITRUM_NATIVE_USDC,
        data: gasEst.data,
        from: MPC,
      })
    : { ok: false };
  const gasParams =
    gasEst.ok && gasPriceJ.ok && arbEth.ok
      ? chooseGasParams({
          liveGasPriceWei: gasPriceJ.wei,
          estimatedGas: gasEst.gas,
          ethBalanceWei: arbEth.wei,
        })
      : { ok: false, blockers: [{ code: "missing_gas_inputs" }] };

  // --- attest + local policy + digest (only if quote OK) ---
  let attestResult = { ok: false, reason: "quote_blocked" };
  let policySim = null;
  let txBundle = null;
  let localSigOk = false;
  let digestBinding = null;
  let rawUnsignedNote = null;

  if (quoteOk && gasParams.ok) {
    const attestor = loadAttestorSecret();
    attestResult = attestTidepoolQuote({
      quoteResponse: quoteResult.one_click_response,
      agentRequest: {
        originAsset: ARB_USDC_ASSET,
        destinationAsset: BASE_USDC_ASSET,
        amount: "1000000",
        depositType: "ORIGIN_CHAIN",
        recipient: MPC,
        refundTo: MPC,
      },
      tokenContract: ARBITRUM_NATIVE_USDC,
      chainId: ARBITRUM_CHAIN_ID,
      maxGasPrice: gasParams.max_gas_price,
      gasLimit: gasParams.gas_limit,
      secretKey64: attestor.secretKey64,
      productionMode: true,
      mainnetFundedPath: true,
      policyLimits: limits,
      allowedDestinations: limits.allowed_destinations,
      allowedAssets: limits.allowed_assets,
      allowedChains: limits.allowed_chains,
    });

    if (attestResult.ok) {
      const msg = Buffer.from(attestResult.message_utf8, "utf8");
      const sigBody = attestResult.signature.replace(/^ed25519:/, "");
      localSigOk = nacl.sign.detached.verify(
        msg,
        bs58.decode(sigBody),
        nacl.sign.keyPair.fromSecretKey(attestor.secretKey64).publicKey
      );

      const policyTx = buildErc20TxParams({
        depositAddress: attestResult.attestation.deposit_address,
        tokenContract: attestResult.attestation.token_contract,
        amountIn: attestResult.attestation.amount_in,
        chainId: attestResult.attestation.chain_id,
        nonce,
        gasPrice: gasParams.gas_price,
        gasLimit: gasParams.gas_limit,
      });

      // Dual binding: policy tx.to = escrow deposit; EIP-155 to = token contract
      const data = erc20TransferData(
        attestResult.attestation.deposit_address,
        attestResult.attestation.amount_in
      );
      const digest = eip155UnsignedDigest({
        nonce,
        gasPrice: BigInt(gasParams.gas_price),
        gasLimit: BigInt(gasParams.gas_limit),
        to: attestResult.attestation.token_contract,
        value: 0n,
        data,
        chainId: ARBITRUM_CHAIN_ID,
      });
      const digest_hex = digestHex(digest);

      digestBinding = {
        policy_tx_to_means: "1click_escrow_deposit",
        policy_tx_to: policyTx.to,
        eip155_tx_to_means: "erc20_token_contract",
        eip155_tx_to: attestResult.attestation.token_contract.toLowerCase(),
        transfer_recipient_in_data: attestResult.attestation.deposit_address.toLowerCase(),
        amount: attestResult.attestation.amount_in,
        digest_hex,
        digest_matches_buildErc20TxParams:
          digest_hex === policyTx.digest_hex,
        note: "On-chain propose binds policy.to==deposit and digest.to==token — both required",
      };

      // Unsigned raw skeleton only — NO MPC signature bytes (would be invalid).
      rawUnsignedNote = {
        signed: false,
        serialize_signed_tx_invoked: false,
        reason: "MPC signature not requested; raw tx not constructed for broadcast",
        would_call_serializeSignedTx_with: {
          nonce,
          gasPrice: gasParams.gas_price,
          gasLimit: gasParams.gas_limit,
          to: attestResult.attestation.token_contract.toLowerCase(),
          data_hex: "0x" + Buffer.from(data).toString("hex"),
          chainId: ARBITRUM_CHAIN_ID,
        },
      };
      // Prove serializeSignedTx exists but do not invent r,s — call with dummy and discard? Better not create fake signed bytes.
      void serializeSignedTx;

      const allowedAssets = new Set(limits.allowed_assets);
      const allowedDestinations = new Set(
        limits.allowed_destinations.map((d) => String(d).toLowerCase())
      );
      const allowedChains = new Set(
        limits.allowed_chains
          .map((c) => {
            const s = String(c);
            if (s.startsWith("eip155:")) return Number(s.slice(7));
            if (/^\d+$/.test(s)) return Number(s);
            return null;
          })
          .filter((n) => n != null)
      );
      const nowNs = BigInt(Date.now()) * 1_000_000n;
      policySim = simulatePolicyChecks({
        attestation: attestResult.attestation,
        tx: {
          ...policyTx,
          gas_price: gasParams.gas_price,
          gas_limit: gasParams.gas_limit,
        },
        expectedEpoch: Number(mandate.mandate_epoch),
        mandateEpoch: Number(mandate.mandate_epoch),
        allowedAssets,
        allowedDestinations,
        allowedChains,
        maxTradeValue: limits.max_trade_value,
        maxSlippageBps: limits.max_slippage_bps,
        maxGasBudget: limits.max_gas_budget,
        trustedSigners: new Set([ATTESTOR_PK]),
        signerPublicKey: ATTESTOR_PK,
        nowNs,
      });

      // Extra policy gates not in simulatePolicyChecks
      const extraFails = [];
      if (mandate.paused) extraFails.push("policy_paused_blocks_propose");
      if (mandate.autonomous_trading) extraFails.push("autonomous_must_stay_off");
      if (mandate.revoked || mandate.signing_revoked) {
        extraFails.push("signing_revoked");
      }
      if (!trusted) extraFails.push("attestor_not_trusted_on_chain");
      if (!limits.allowed_venues?.includes("near_intents_1click")) {
        extraFails.push("venue_near_intents_1click_missing");
      }
      if (String(limits.token_scope).toLowerCase() !== "allowlist") {
        extraFails.push("token_scope_not_allowlist");
      }
      if (
        String(mandate.intents_signer_id || "").toLowerCase() !== MPC
      ) {
        extraFails.push("intents_signer_id_mismatch");
      }
      if (BigInt(String(reserved?.toString?.() ?? reserved ?? "0")) > 0n) {
        // reserved is U128 object or string
      }
      const reservedRaw = BigInt(
        typeof reserved === "object" && reserved !== null
          ? reserved.toString?.() || reserved[0] || "0"
          : String(reserved || "0")
      );
      if (
        reservedRaw + 1000000n >
        BigInt(limits.max_pending_exposure)
      ) {
        extraFails.push("pending_exposure_would_exceed");
      }
      if (!gates.funded_trading) {
        extraFails.push("backend_funded_trading_gate_false");
      }
      if (!gates.mainnet_broadcast_enabled) {
        extraFails.push("backend_broadcast_gate_false");
      }

      policySim = {
        ...policySim,
        execution_blockers_for_j8b: extraFails,
        local_authorization_ok: policySim.ok && localSigOk,
      };

      txBundle = {
        policy_tx: policyTx,
        nonce,
        gas_price: gasParams.gas_price,
        gas_limit: gasParams.gas_limit,
        max_gas_price: gasParams.max_gas_price,
        digest_binding: digestBinding,
        raw_unsigned: rawUnsignedNote,
        mpc_signing_request_shape: {
          method: "propose_quoted_evm_transfer then request_signature",
          invoked: false,
          payload_commitment_would_be: digest_hex,
          domain_id: 0,
          path: MAINNET_IDENTITIES.derivation_path,
          predecessor: MAINNET_IDENTITIES.policy,
        },
      };
    }
  }

  // Prove broadcast gate refuses
  const broadcastProbe = await guardedMainnetSubmit(async () => {
    throw new Error("should_never_run");
  });
  mutations.eth_sendRawTransaction = false;

  const usdcEnough =
    arbUsdc.ok && BigInt(arbUsdc.raw) >= 1000000n;
  const fundingOk =
    ethRcptOk &&
    usdcRcptOk &&
    arbEth.ok &&
    BigInt(arbEth.wei) > 0n &&
    usdcEnough;

  const localPathOk =
    quoteOk &&
    attestResult.ok &&
    localSigOk &&
    policySim?.ok === true &&
    gasParams.ok &&
    chain.ok &&
    fundingOk;

  const j8bBlockers = [
    ...(policySim?.execution_blockers_for_j8b || []),
    ...(!localPathOk
      ? [{ code: "local_preflight_incomplete" }]
      : []),
  ];
  // Normalize blockers to strings
  const blockerCodes = j8bBlockers.map((b) =>
    typeof b === "string" ? b : b.code
  );

  const goNoGo =
    localPathOk &&
    mandate.paused === true &&
    mandate.autonomous_trading === false &&
    trusted === true
      ? {
          preflight: "GO",
          execution: "NO-GO",
          reason:
            "Local quote→attest→digest path PASS; execution awaits J8B owner Ledger unpause + explicit gate unlocks + operator confirm. Do not execute now.",
        }
      : {
          preflight: "NO-GO",
          execution: "NO-GO",
          reason: "Preflight incomplete or unsafe — see blockers",
        };

  return {
    checkpoint: "J8A",
    at,
    mpc: MPC,
    mutations,
    broadcast_probe: broadcastProbe,
    funding: {
      eth_tx: FUNDING_ETH_TX,
      usdc_tx: FUNDING_USDC_TX,
      eth_receipt_ok: ethRcptOk,
      usdc_receipt_ok: usdcRcptOk,
      balances: {
        arbitrum: {
          chain_id: chain.chain_id,
          chain_ok: chain.ok,
          eth_wei: arbEth.ok ? arbEth.wei : null,
          eth: arbEth.ok ? arbEth.ether : null,
          usdc_raw: arbUsdc.ok ? arbUsdc.raw : null,
          usdc: arbUsdc.ok ? arbUsdc.ui : null,
          usdc_contract: ARBITRUM_NATIVE_USDC,
          nonce,
        },
        base: {
          eth_wei: baseEth.ok ? baseEth.wei : null,
          eth: baseEth.ok ? baseEth.ether : null,
          usdc_raw: baseUsdcFixed.ok ? baseUsdcFixed.raw : null,
          usdc: baseUsdcFixed.ok ? baseUsdcFixed.ui : null,
          usdc_contract: MAINNET_USDC.base.toLowerCase(),
        },
      },
      ok: fundingOk,
    },
    policy: {
      paused: mandate.paused,
      autonomous_trading: mandate.autonomous_trading,
      revoked: mandate.revoked,
      mandate_epoch: mandate.mandate_epoch,
      trusted_attestor: trusted,
      attestor_pk: ATTESTOR_PK,
      intents_signer_id: mandate.intents_signer_id,
      reserved_pending_exposure: reserved,
      unresolved_pending: mandate.unresolved_pending,
      limits: {
        max_trade_value: limits.max_trade_value,
        max_slippage_bps: limits.max_slippage_bps,
        max_gas_budget: limits.max_gas_budget,
        max_pending_exposure: limits.max_pending_exposure,
        token_scope: limits.token_scope,
        allowed_venues: limits.allowed_venues,
        allowed_chains: limits.allowed_chains,
        allowed_destinations: limits.allowed_destinations,
        arb_usdc_allowed: limits.allowed_assets.includes(ARB_USDC_ASSET),
        base_usdc_allowed: limits.allowed_assets.includes(BASE_USDC_ASSET),
        mpc_destination_allowed: limits.allowed_destinations
          .map((d) => d.toLowerCase())
          .includes(MPC),
      },
    },
    gates,
    quote: {
      ok: Boolean(quoteOk),
      dry: quoteResult?.dry,
      reason: quoteResult?.reason || null,
      verify: quoteResult?.one_click_verify || null,
      amount_in: quoteResult?.amount_in || null,
      amount_out: quoteResult?.amount_out || null,
      min_amount_out: quoteResult?.min_amount_out || null,
      deposit_address: quoteResult?.deposit_address || null,
      correlation_id: quoteResult?.correlation_id || null,
      timestamp: quoteResult?.timestamp || null,
      floor_eval: floorEval,
      reused_old_quote: false,
      values_altered: false,
    },
    gas: {
      eth_gasPrice_wei: gasPriceJ.ok ? gasPriceJ.wei : null,
      eth_gasPrice_gwei: gasPriceJ.ok ? gasPriceJ.gwei : null,
      estimate: gasEst,
      node_l1: l1,
      chosen: gasParams,
    },
    attestation: {
      ok: Boolean(attestResult.ok),
      reason: attestResult.reason || null,
      local_sig_ok: localSigOk,
      attestation_id: attestResult.attestation_id || null,
      publicKey: attestResult.publicKey || null,
      attestation: attestResult.attestation || null,
      signature_prefix: attestResult.signature
        ? String(attestResult.signature).slice(0, 24) + "…"
        : null,
      checks: attestResult.checks || null,
    },
    local_simulation: {
      policy: policySim,
      tx_bundle: txBundle,
      path_ok: localPathOk,
      on_chain_state_mutated: false,
      request_signature_called: false,
      propose_called: false,
    },
    blockers_for_j8b_execution: blockerCodes,
    go_no_go: goNoGo,
  };
}

export function buildJ8bRunbook(preflight) {
  const q = preflight.quote;
  const g = preflight.gas.chosen;
  return {
    title: "J8B — first 1 USDC Arb→Base execution (owner-approved, non-autonomous)",
    posture: {
      autonomous_trading: "MUST remain false",
      confirm_each_mutation: true,
      reuse_j8a_quote: false,
      note: "Fetch a NEW non-dry quote at execution time; J8A quote may expire",
    },
    ledger_actions: [
      {
        step: "L1",
        method: "set_paused",
        args: { paused: false },
        signer: "nishanthb.near",
        receiver: "policy.nishanthb.near",
        hd_path: "m/44'/397'/0'/0'/1'",
        require_explicit_confirm: true,
        purpose: "Unpause so agent can propose_quoted_evm_transfer",
      },
      {
        step: "L2-optional-emergency",
        method: "set_paused",
        args: { paused: true },
        purpose: "Emergency re-pause",
      },
      {
        step: "L3-optional-emergency",
        method: "remove_trusted_quote_signer",
        args: { public_key: ATTESTOR_PK },
        purpose: "Revoke attestor if compromise suspected",
      },
    ],
    agent_calls: [
      {
        step: "A0",
        action: "Operator sets temporary execution env unlocks ONLY for this run",
        detail:
          "Funded trading + broadcast gates require explicit code/checkpoint unlock in J8B — not ambient forever",
      },
      {
        step: "A1",
        action: "Fetch fresh non-dry 1Click quote (25 bps, 1 USDC Arb→Base, MPC recipient/refund)",
      },
      {
        step: "A2",
        action: "Production attest with registered attestor key (pinned manager, escrow in hash, floor check)",
      },
      {
        step: "A3",
        action: "agent.nishanthb.near → propose_quoted_evm_transfer",
        args_shape: {
          operation_id: "j8b-<timestamp>",
          attestation: "<from A2>",
          attestation_signature: "<from A2>",
          signer_public_key: ATTESTOR_PK,
          tx: {
            nonce: "<eth_getTransactionCount pending>",
            gas_price: "<= attestation.max_gas_price (live*1.5, no 1gwei floor)",
            gas_limit: "== attestation.gas_limit",
            chain_id: "42161",
            token_contract: ARBITRUM_NATIVE_USDC,
            to: "<quote.depositAddress escrow>",
            amount: "1000000",
          },
          expected_epoch: 2,
        },
      },
      {
        step: "A4",
        action: "agent.nishanthb.near → request_signature(operation_id) with 1 yocto",
        note: "Triggers v1.signer MPC — first real mainnet sign",
      },
      {
        step: "A5",
        action: "Assemble EIP-155 raw tx (to=token, data=transfer(escrow,amount)) and eth_sendRawTransaction once",
      },
    ],
    expected_state_changes: [
      "policy.paused: true → false (after L1)",
      "pending[operation_id] reserved; reserved_pending_exposure += 1000000",
      "attestation_id consumed in storage",
      "Arbitrum: MPC USDC -= 1000000; escrow += 1000000; ETH gas spent",
      "1Click settlement progresses; Base MPC USDC increases by ~minAmountOut",
    ],
    signed_evm_tx_checks: [
      "Recovered signer == " + MPC,
      "chainId == 42161",
      "nonce matches propose",
      "to == native USDC token (NOT escrow, NOT USDC.e)",
      "data == transfer(escrowDeposit, 1000000)",
      "keccak(unsigned) == policy payload_commitment",
      "gasPrice <= attested max_gas_price",
      "gasLimit == attested gas_limit",
    ],
    source_receipt_verification: [
      "status == 0x1",
      "Transfer log token=" + ARBITRUM_NATIVE_USDC,
      "from=" + MPC,
      "to=escrow deposit from THIS quote",
      "value=1000000",
    ],
    settlement_monitoring: [
      "Poll 1Click status by correlationId until SUCCESS or terminal failure",
      "Do not resign same attestation_id",
      "Do not rebroadcast different bytes for same nonce without owner cancel path",
    ],
    base_usdc_verification: [
      "balanceOf(MPC) on " + MAINNET_USDC.base + " increases",
      "delta >= attested min_amount_out (policy floor aware)",
      "chainId Base 8453",
    ],
    timeout_failure: [
      "If quote expires before propose: abort, re-quote, new attestation",
      "If propose succeeds but MPC sign fails: owner may need cancel/replace nonce path",
      "If broadcast stuck: wait; never resign different digest at same nonce",
      "If 1Click fails after deposit: follow official recovery; keep paused if unsure",
    ],
    emergency: [
      "Ledger set_paused(true) immediately",
      "Optional remove_trusted_quote_signer",
      "Do not enable autonomous_trading",
    ],
    j8a_reference: {
      sample_deposit_do_not_reuse: q.deposit_address,
      sample_min_out: q.min_amount_out,
      gas_model: g,
    },
  };
}
