/**
 * J8B-1 — real mainnet canary adapters (agent.nishanthb.near ops credential).
 * Constructing adapters does NOT submit. Callers must invoke methods explicitly.
 */
import * as nearAPI from "near-api-js";
import { MAINNET } from "../networks/profiles.mjs";
import { pickRpc, viewFunction } from "../networks/rpc.mjs";
import { MAINNET_IDENTITIES, MAINNET_EVM_RPCS } from "./identities.mjs";
import { loadAgentOpsCredentials, redactSecrets } from "./agentCredentials.mjs";
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
  decodeSignedEip155Tx,
} from "../intents-codec/quote-auth.mjs";
import { CANARY_TOKEN, CANARY_CHAIN_ID, CANARY_AMOUNT } from "./canaryOneShot.mjs";
import { localTxHash } from "../execution/txJournal.mjs";

const { connect, keyStores, providers } = nearAPI;

export async function ethJsonRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

/**
 * Create live adapters. Does not mutate chain until methods are called.
 */
export async function createMainnetCanaryAdapters(opts = {}) {
  const env = opts.env || process.env;
  const cred = loadAgentOpsCredentials({
    env,
    accountId: MAINNET_IDENTITIES.agent,
    expectedPublicKey: MAINNET_IDENTITIES.ops_public_key,
    path: opts.opsKeyPath,
  });
  const rpc = opts.rpc || (await pickRpc(MAINNET.near.rpcs));
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey("mainnet", MAINNET_IDENTITIES.agent, cred.keyPair);
  const near = await connect({
    networkId: "mainnet",
    nodeUrl: rpc,
    deps: { keyStore },
  });
  const agentAccount = await near.account(MAINNET_IDENTITIES.agent);
  const provider = new providers.JsonRpcProvider({ url: rpc });
  const arbRpc = opts.arbRpc || MAINNET_EVM_RPCS.arbitrum;
  const baseRpc = opts.baseRpc || MAINNET_EVM_RPCS.base;
  const policy = MAINNET_IDENTITIES.policy;

  return {
    kind: "mainnet_canary_adapters_v1",
    network: "mainnet",
    agent: MAINNET_IDENTITIES.agent,
    policy,
    credential: cred.log_safe,
    rpc,
    arbRpc,
    baseRpc,

    view: (method, args = {}) => viewFunction(rpc, policy, method, args),

    async getPaused() {
      return Boolean(await viewFunction(rpc, policy, "get_paused", {}));
    },
    async getMandateEpoch() {
      return Number(await viewFunction(rpc, policy, "get_mandate_epoch", {}));
    },
    async getLimits() {
      return viewFunction(rpc, policy, "get_limits", {});
    },
    async getPending(operationId) {
      return viewFunction(rpc, policy, "get_pending", {
        operation_id: operationId,
      });
    },
    async listPending() {
      return viewFunction(rpc, policy, "list_pending", {});
    },
    async getGateJMandate() {
      return viewFunction(rpc, policy, "get_gate_j_mandate", {});
    },
    async getReconciler() {
      return viewFunction(rpc, policy, "get_reconciler", {});
    },
    async isTrustedQuoteSigner(publicKey) {
      return viewFunction(rpc, policy, "is_trusted_quote_signer", {
        public_key: publicKey,
      });
    },

    /**
     * REAL propose — only call after operator confirm + unpause verified.
     */
    async proposeQuotedEvmTransfer(args) {
      const outcome = await agentAccount.functionCall({
        contractId: policy,
        methodName: "propose_quoted_evm_transfer",
        args,
        gas: BigInt("100000000000000"),
        attachedDeposit: 0n,
      });
      return {
        ok: true,
        method: "propose_quoted_evm_transfer",
        transaction_hash: outcome?.transaction_outcome?.id || outcome?.transaction?.hash || null,
        outcome: redactSecrets(outcome),
      };
    },

    /**
     * REAL request_signature with 1 yoctoNEAR.
     */
    async requestSignature(operationId) {
      const outcome = await agentAccount.functionCall({
        contractId: policy,
        methodName: "request_signature",
        args: { operation_id: operationId },
        gas: BigInt("300000000000000"),
        attachedDeposit: 1n,
      });
      return {
        ok: true,
        method: "request_signature",
        transaction_hash:
          outcome?.transaction_outcome?.id || outcome?.transaction?.hash || null,
        outcome: redactSecrets(outcome),
      };
    },

    /**
     * REAL reconcile_pending — owner/reconciler path only.
     * Caller must verify Base USDC + source receipts BEFORE invoke.
     * Does NOT auto-run; operator CLI requires --invoke + prior confirm.
     */
    async reconcilePending({
      operationId,
      settlementState = "Success",
      evidenceHash,
    }) {
      if (!evidenceHash || String(evidenceHash).length < 16) {
        return { ok: false, reason: "evidence_hash_required" };
      }
      const outcome = await agentAccount.functionCall({
        contractId: policy,
        methodName: "reconcile_pending",
        args: {
          operation_id: operationId,
          settlement_state: settlementState,
          evidence_hash: String(evidenceHash),
        },
        gas: BigInt("50000000000000"),
        attachedDeposit: 0n,
      });
      return {
        ok: true,
        method: "reconcile_pending",
        transaction_hash:
          outcome?.transaction_outcome?.id || outcome?.transaction?.hash || null,
        outcome: redactSecrets(outcome),
        note: "verified_onchain:false — evidence_hash is audit pointer only",
      };
    },

    async waitNearTx(txHash, signerId = MAINNET_IDENTITIES.agent) {
      // Finality: EXPERIMENTAL_tx_status
      const full = await provider.sendJsonRpc("EXPERIMENTAL_tx_status", [
        txHash,
        signerId,
      ]);
      return full;
    },

    async eth(method, params, { chain = "arbitrum" } = {}) {
      const url = chain === "base" ? baseRpc : arbRpc;
      return ethJsonRpc(url, method, params);
    },

    /**
     * Assemble EIP-155 raw tx from MPC NEAR result. Rejects if recovered signer ≠ MPC.
     */
    assembleEip155FromMpcNearTx({
      nearTxFull,
      nonce,
      gasPrice,
      gasLimit,
      depositAddress,
      amount = CANARY_AMOUNT,
      token = CANARY_TOKEN,
      chainId = CANARY_CHAIN_ID,
      expectedMpc = MAINNET_IDENTITIES.mpc_evm_address,
      expectedDigestHex = null,
    }) {
      const extracted = extractMpcSigFromNearTx(nearTxFull);
      if (!extracted.found) {
        return { ok: false, reason: "MPC_SIG_NOT_FOUND" };
      }
      const data = erc20TransferData(depositAddress, amount);
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
        token: token.toLowerCase(),
        deposit_address: String(depositAddress).toLowerCase(),
        amount: String(amount),
        nonce: Number(nonce),
        gas_price: String(gasPrice),
        gas_limit: String(gasLimit),
        chain_id: Number(chainId),
      };
    },

    /**
     * Decode + verify a serialized signed tx against authorization (no send).
     * Recovers signer; never re-signs.
     */
    verifySignedRawAgainstAuth(rawHex, auth) {
      const want = {
        token: String(auth.token || CANARY_TOKEN).toLowerCase(),
        deposit: String(auth.deposit_address).toLowerCase(),
        amount: String(auth.amount || CANARY_AMOUNT),
        nonce: Number(auth.nonce),
        gas_price: String(auth.gas_price),
        gas_limit: String(auth.gas_limit),
        chain_id: Number(auth.chain_id || CANARY_CHAIN_ID),
        digest: String(auth.digest_hex).toLowerCase(),
        mpc: String(auth.mpc || MAINNET_IDENTITIES.mpc_evm_address).toLowerCase(),
        local_tx_hash: auth.local_tx_hash
          ? String(auth.local_tx_hash).toLowerCase()
          : null,
        payload_commitment: auth.payload_commitment
          ? String(auth.payload_commitment).toLowerCase()
          : null,
      };
      const decoded = decodeSignedEip155Tx(rawHex, {
        recoverFn: (hash, r, s, recoveryId) => {
          let addr = recoverFromHash(hash, r, s, recoveryId);
          if (addr.toLowerCase() !== want.mpc) {
            const alt = recoverFromHash(hash, r, s, recoveryId ^ 1);
            if (alt.toLowerCase() === want.mpc) addr = alt;
          }
          return addr;
        },
      });
      if (!decoded.ok) return decoded;
      if (decoded.chainId !== CANARY_CHAIN_ID || decoded.chainId !== want.chain_id) {
        return { ok: false, reason: "wrong_chain_id", got: decoded.chainId };
      }
      if (decoded.to !== want.token || decoded.to !== CANARY_TOKEN) {
        return { ok: false, reason: "wrong_token", got: decoded.to };
      }
      if (decoded.nonce !== want.nonce) {
        return { ok: false, reason: "nonce_mismatch", got: decoded.nonce };
      }
      if (decoded.gasPrice !== want.gas_price) {
        return { ok: false, reason: "gas_price_mismatch", got: decoded.gasPrice };
      }
      if (decoded.gasLimit !== want.gas_limit) {
        return { ok: false, reason: "gas_limit_mismatch", got: decoded.gasLimit };
      }
      if (!decoded.transfer) {
        return { ok: false, reason: "not_erc20_transfer" };
      }
      if (decoded.transfer.recipient !== want.deposit) {
        return { ok: false, reason: "escrow_mismatch", got: decoded.transfer.recipient };
      }
      if (decoded.transfer.amount !== want.amount || decoded.transfer.amount !== CANARY_AMOUNT) {
        return { ok: false, reason: "amount_mismatch", got: decoded.transfer.amount };
      }
      if (decoded.digest_hex.toLowerCase() !== want.digest) {
        return { ok: false, reason: "digest_mismatch_vs_auth" };
      }
      if (
        want.payload_commitment &&
        decoded.digest_hex.toLowerCase() !== want.payload_commitment
      ) {
        return { ok: false, reason: "payload_commitment_mismatch" };
      }
      if (!decoded.recovered || decoded.recovered !== want.mpc) {
        return {
          ok: false,
          reason: "recovered_signer_mismatch",
          recovered: decoded.recovered,
          expected: want.mpc,
        };
      }
      if (want.local_tx_hash) {
        const got = localTxHash(decoded.rawHex);
        if (got.toLowerCase() !== want.local_tx_hash) {
          return { ok: false, reason: "local_tx_hash_mismatch", got };
        }
      }
      return {
        ok: true,
        digest_hex: decoded.digest_hex,
        recovered: decoded.recovered,
        chain_id: decoded.chainId,
        nonce: decoded.nonce,
        token: decoded.to,
        escrow: decoded.transfer.recipient,
        amount: decoded.transfer.amount,
        gas_price: decoded.gasPrice,
        gas_limit: decoded.gasLimit,
      };
    },
  };
}
