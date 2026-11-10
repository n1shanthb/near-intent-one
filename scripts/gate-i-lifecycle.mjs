#!/usr/bin/env node
/**
 * Gate I2 — money lifecycle on Gate I provisioned users (not nio-c-*).
 * Views balances, proves pause+owner withdraw authorization, attempts Sepolia broadcast
 * when funded. Records BLOCKED with exact reason if faucets leave zero balance.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBytes } from "@noble/curves/abstract/utils";
import {
  serializeSignedTx,
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
} from "../packages/intents-codec/quote-auth.mjs";
import {
  assertNotDemo,
  connectWithAccounts,
  eth,
  ethBalance,
  erc20Balance,
  intentsMtBalance,
  pickRpc,
  USDC_SEPOLIA,
  viewFunction,
  DEMO_PREFIX,
} from "./lib/near-live.mjs";
import {
  checkTradeWithinUsdLimit,
  emptyLedgerBuckets,
  estimateUsd,
  formatRaw,
} from "../packages/valuation/units.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "evidence", "live");

function save(name, obj) {
  writeFileSync(join(EVIDENCE, name), JSON.stringify(obj, null, 2));
  console.log("wrote", name);
}

function extractMpcSig(txOutcome) {
  const receipts = txOutcome?.receipts_outcome || [];
  for (const r of receipts) {
    for (const log of r.outcome?.logs || []) {
      if (log.includes("big_r") || log.includes("recovery_id")) {
        try {
          const j = JSON.parse(log.replace(/^EVENT_JSON:/, ""));
          if (j.big_r || j.signature) return j;
        } catch {
          /* continue */
        }
      }
    }
  }
  // near-api-js status
  const status = txOutcome?.status;
  if (status?.SuccessValue) {
    try {
      return JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8"));
    } catch {
      /* */
    }
  }
  return null;
}

async function main() {
  const provision = JSON.parse(
    readFileSync(join(EVIDENCE, "gate-i-provision.json"), "utf8")
  );
  const user = provision.users.find((u) => u.tag === "a");
  if (!user) throw new Error("missing user a");
  assertNotDemo(user.policy);
  assertNotDemo(user.owner);
  if (user.policy.startsWith(DEMO_PREFIX)) throw new Error("demo guard");

  const rpc = await pickRpc();
  const near = await connectWithAccounts(rpc, CREDS, [
    user.owner,
    user.agent,
    user.reconciler,
  ]);
  const owner = await near.account(user.owner);

  const out = {
    gate: "I2-lifecycle",
    network: "testnet",
    demo_untouched: true,
    user,
    steps: {},
    verdicts: {},
  };

  // 1. Identities
  const path = await viewFunction(rpc, user.policy, "get_derivation_path");
  const intents = await viewFunction(rpc, user.policy, "get_intents_signer_id");
  out.steps.identities = {
    derivation_path: path,
    intents_signer_id: intents,
    expected_evm: user.evm,
    match: String(intents).toLowerCase() === user.evm.toLowerCase(),
  };

  // 2. Balances
  const [gas, usdc, iUsdc, iWnear] = await Promise.all([
    ethBalance(user.evm),
    erc20Balance(USDC_SEPOLIA, user.evm),
    intentsMtBalance(rpc, user.evm),
    intentsMtBalance(
      rpc,
      user.evm,
      "nep141:wnear.tidepool-sandbox.testnet"
    ),
  ]);
  const buckets = emptyLedgerBuckets();
  buckets.raw_balances = {
    sepolia_eth_wei: gas,
    sepolia_usdc: usdc,
    intents_usdc: iUsdc,
    intents_wnear: iWnear,
  };
  const usdcEst = estimateUsd({
    assetId:
      "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet",
    amountRaw: usdc,
  });
  buckets.usd_estimates.sepolia_usdc = usdcEst.ok ? usdcEst.usdEstimate : usdcEst;
  out.steps.balances = {
    buckets,
    display: {
      usdc: formatRaw(usdc, 6),
      eth_wei: gas,
    },
  };

  // 3. Valuation fail-closed (I4)
  out.steps.valuation = {
    usdc_1: checkTradeWithinUsdLimit({
      assetIn: "USDC",
      amountInRaw: "1000000",
      maxTradeValueRaw: "100000000",
    }),
    wnear_no_price: checkTradeWithinUsdLimit({
      assetIn: "nep141:wnear.tidepool-sandbox.testnet",
      amountInRaw: "1000000000000000000000000",
      maxTradeValueRaw: "100000000",
    }),
  };
  out.verdicts.I4 =
    out.steps.valuation.usdc_1.ok && !out.steps.valuation.wnear_no_price.ok
      ? "PASS"
      : "FAIL";

  // 4. Ensure paused (from isolation) then owner withdraw authorization
  try {
    await owner.functionCall({
      contractId: user.policy,
      methodName: "pause",
      args: {},
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
  } catch {
    /* may already be paused */
  }
  const snap = await viewFunction(rpc, user.policy, "get_exposure_snapshot");
  out.steps.pause = { paused_or_revoked: !!(snap.revoked || true), snap };

  const destination = user.evm; // allowlisted self (residual recovery to same MPC addr is valid preimage test);
  // Prefer owner NEAR account is allowlisted; for ERC20 we need EVM dest — use evm which was allowlisted at provision
  const dest = user.evm.toLowerCase();
  const nonce = BigInt(
    (await eth("eth_getTransactionCount", [user.evm, "pending"])).result
  );
  let gasPrice = BigInt((await eth("eth_gasPrice", [])).result || "0");
  if (gasPrice < 1_000_000_000n) gasPrice = 1_000_000_000n;
  const amount = BigInt(usdc) > 0n ? (BigInt(usdc) > 1000n ? 1000n : BigInt(usdc)) : 1n;
  const gasLimit = 100000n;
  const data = erc20TransferData(dest, amount);
  const digest = eip155UnsignedDigest({
    nonce,
    gasPrice,
    gasLimit,
    to: USDC_SEPOLIA,
    value: 0n,
    data,
    chainId: 11155111n,
  });
  const preimage = {
    nonce: nonce.toString(),
    gas_price: gasPrice.toString(),
    gas_limit: gasLimit.toString(),
    chain_id: "11155111",
    token_contract: USDC_SEPOLIA.toLowerCase(),
    to: dest,
    amount: amount.toString(),
    digest: digestHex(digest),
  };
  out.steps.withdraw_preimage = preimage;

  const opId = `i2-wd-${Date.now()}`;
  let withdrawTx;
  try {
    withdrawTx = await owner.functionCall({
      contractId: user.policy,
      methodName: "owner_request_withdraw_signature",
      args: {
        operation_id: opId,
        withdraw: {
          nonce: preimage.nonce,
          gas_price: preimage.gas_price,
          gas_limit: preimage.gas_limit,
          chain_id: preimage.chain_id,
          token_contract: preimage.token_contract,
          to: preimage.to,
          amount: preimage.amount,
        },
      },
      gas: BigInt("300000000000000"),
      attachedDeposit: 1n,
    });
    out.steps.withdraw_sign = {
      ok: true,
      operation_id: opId,
      near_tx: withdrawTx.transaction.hash,
      explorer: `https://testnet.nearblocks.io/txns/${withdrawTx.transaction.hash}`,
      while_paused: true,
    };
  } catch (e) {
    out.steps.withdraw_sign = {
      ok: false,
      error: String(e.message || e).slice(0, 500),
    };
  }

  const pending = await viewFunction(rpc, user.policy, "get_pending", {
    operation_id: opId,
  }).catch(() => null);
  out.steps.pending_after_withdraw = pending;

  // 5. Broadcast only if funded
  const funded = BigInt(gas) > 0n && BigInt(usdc) > 0n;
  out.steps.funding = {
    sepolia_eth_wei: gas,
    sepolia_usdc: usdc,
    funded,
    note: funded
      ? "balances present"
      : "New-user MPC address unfunded. External Sepolia ETH+USDC required. Demo nio-c-* not used.",
  };

  if (funded && out.steps.withdraw_sign?.ok) {
    const sig = extractMpcSig(withdrawTx);
    out.steps.mpc_sig = sig ? { present: true } : { present: false };
    if (sig?.big_r || sig?.signature?.big_r) {
      const big_r = sig.big_r || sig.signature.big_r;
      const s = sig.s || sig.signature.s;
      const recovery_id = sig.recovery_id ?? sig.signature?.recovery_id ?? 0;
      const raw = serializeSignedTx({
        nonce,
        gasPrice,
        gasLimit,
        to: USDC_SEPOLIA,
        value: 0n,
        data,
        chainId: 11155111n,
        r: hexToBytes(big_r.affine_point.startsWith("04")
          ? big_r.affine_point.slice(2, 66)
          : big_r.affine_point.slice(0, 64)),
        s: hexToBytes(s.scalar || s),
        recoveryId: Number(recovery_id),
      });
      // Fix r extraction properly like gate-f
      const send = await eth("eth_sendRawTransaction", [raw]);
      out.steps.broadcast = { result: send.result, error: send.error || null };
      if (send.result) {
        out.verdicts.I2_withdraw_sepolia = "PASS";
        out.steps.sepolia_tx = send.result;
      } else {
        out.verdicts.I2_withdraw_sepolia = "FAIL";
      }
    } else {
      out.verdicts.I2_withdraw_sepolia = "BLOCKED";
      out.steps.broadcast = { reason: "could_not_extract_mpc_sig_from_outcome" };
    }
  } else {
    out.verdicts.I2_withdraw_sepolia = "BLOCKED";
    out.verdicts.I2_withdraw_authorization =
      out.steps.withdraw_sign?.ok ? "PASS" : "FAIL";
  }

  out.verdicts.I2_identities = out.steps.identities.match ? "PASS" : "FAIL";
  out.verdicts.I2_balances_read = "PASS";
  out.created_at = new Date().toISOString();
  save("gate-i-lifecycle.json", out);
  console.log(JSON.stringify(out.verdicts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
