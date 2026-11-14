/**
 * Mission 2 production adapters — Base chain defaults (not Eth Mission1, not Arb J8B).
 */
import { MAINNET_IDENTITIES, MAINNET_EVM_RPCS } from "./identities.mjs";
import { createMainnetCanaryAdapters, ethJsonRpc } from "./canaryAdapters.mjs";
import { createViewOnlyPolicyAdapters } from "./canaryRecovery.mjs";
import {
  MISSION2_CHAIN_ID,
  MISSION2_TOKEN,
} from "./mission2ExecutionPath.mjs";
import {
  extractMpcSigFromNearTx,
  mpcToRsV,
  recoverFromHash,
} from "../gate-k/settle.mjs";
import {
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
  serializeSignedTx,
} from "../intents-codec/quote-auth.mjs";
import { verifyMission2SignedRaw } from "./mission2Safety.mjs";

export async function createMission2ViewAdapters(opts = {}) {
  const base = await createViewOnlyPolicyAdapters(opts);
  const policy = MAINNET_IDENTITIES.policy;
  return {
    ...base,
    kind: "mission2_view_adapters_v1",
    baseRpc: opts.baseRpc || MAINNET_EVM_RPCS.base,
    ethRpc: opts.baseRpc || MAINNET_EVM_RPCS.base,
    async eth(method, params) {
      return ethJsonRpc(this.baseRpc, method, params);
    },
    async getLimits() {
      return viewFunction(base.rpc, policy, "get_limits", {});
    },
    async getEvidenceHash(operationId) {
      return viewEvidence(base, operationId);
    },
  };
}

async function viewFunction(rpc, accountId, methodName, args) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: accountId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
  };
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.result?.result) return null;
  return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
}

async function viewEvidence(adapters, operationId) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: MAINNET_IDENTITIES.policy,
      method_name: "get_evidence_hash",
      args_base64: Buffer.from(JSON.stringify({ operation_id: operationId })).toString("base64"),
    },
  };
  const res = await fetch(adapters.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.result?.result) return null;
  return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
}

export async function createMission2LiveAdapters(opts = {}) {
  const base = await createMainnetCanaryAdapters(opts);
  const baseRpc = opts.baseRpc || MAINNET_EVM_RPCS.base;
  return {
    ...base,
    kind: "mission2_live_adapters_v1",
    baseRpc,
    ethRpc: baseRpc,
    independent_of_j8b: true,
    rejects_eth_operator: true,
    async eth(method, params) {
      return ethJsonRpc(baseRpc, method, params);
    },
    async getEvidenceHash(operationId) {
      return viewEvidence(base, operationId);
    },
    assembleEip155FromMpcNearTx({
      nearTxFull,
      nonce,
      gasPrice,
      gasLimit,
      depositAddress,
      amount,
      token = MISSION2_TOKEN,
      chainId = MISSION2_CHAIN_ID,
      expectedMpc = MAINNET_IDENTITIES.mpc_evm_address,
      expectedDigestHex = null,
    }) {
      if (amount == null || amount === "") {
        return { ok: false, reason: "amount_required_for_base_assembly" };
      }
      const extracted = extractMpcSigFromNearTx(nearTxFull);
      if (!extracted.found) {
        return { ok: false, reason: extracted.reason || "MPC_SIG_NOT_FOUND" };
      }
      const data = erc20TransferData(depositAddress, String(amount));
      const digestBytes = eip155UnsignedDigest({
        nonce: BigInt(nonce),
        gasPrice: BigInt(gasPrice),
        gasLimit: BigInt(gasLimit),
        to: token,
        data,
        chainId: Number(chainId),
      });
      const digest_hex = digestHex(digestBytes);
      if (
        expectedDigestHex &&
        digest_hex.toLowerCase() !== String(expectedDigestHex).toLowerCase()
      ) {
        return { ok: false, reason: "digest_recalc_mismatch", digest_hex };
      }
      let { r, s, recoveryId } = mpcToRsV(extracted.signature_json);
      let recovered = recoverFromHash(digestBytes, r, s, recoveryId);
      const mpc = String(expectedMpc).toLowerCase();
      if (recovered.toLowerCase() !== mpc) {
        const alt = recoveryId ^ 1;
        if (recoverFromHash(digestBytes, r, s, alt).toLowerCase() === mpc) {
          recoveryId = alt;
          recovered = mpc;
        }
      }
      if (recovered.toLowerCase() !== mpc) {
        return {
          ok: false,
          reason: "recovered_address_mismatch",
          recovered: recovered.toLowerCase(),
          expected: mpc,
        };
      }
      if (Number(chainId) !== MISSION2_CHAIN_ID) {
        return { ok: false, reason: "wrong_chain_id", got: chainId };
      }
      if (String(token).toLowerCase() !== MISSION2_TOKEN) {
        return { ok: false, reason: "wrong_token", got: token };
      }
      const rawHex = serializeSignedTx({
        nonce: BigInt(nonce),
        gasPrice: BigInt(gasPrice),
        gasLimit: BigInt(gasLimit),
        to: token,
        data,
        chainId: Number(chainId),
        r,
        s,
        recoveryId,
      });
      return {
        ok: true,
        rawHex,
        digest_hex,
        recovered: mpc,
        observed_digest_hex: digest_hex,
        token: MISSION2_TOKEN,
        deposit_address: String(depositAddress).toLowerCase(),
        amount: String(amount),
        nonce: Number(nonce),
        gas_price: String(gasPrice),
        gas_limit: String(gasLimit),
        chain_id: MISSION2_CHAIN_ID,
      };
    },
    verifySignedRawAgainstAuth(rawHex, auth) {
      return verifyMission2SignedRaw(rawHex, auth, {
        recoverFn: (hash, r, s, recoveryId) => {
          let addr = recoverFromHash(hash, r, s, recoveryId);
          const mpc = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
          if (addr.toLowerCase() !== mpc) {
            const alt = recoverFromHash(hash, r, s, recoveryId ^ 1);
            if (alt.toLowerCase() === mpc) addr = alt;
          }
          return addr;
        },
      });
    },
  };
}