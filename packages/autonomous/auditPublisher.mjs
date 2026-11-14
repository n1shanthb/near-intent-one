/**
 * Agent-signed record_decision_cycle publisher (mainnet).
 * Requires method deployed; never fabricates success.
 */
import * as nearAPI from "near-api-js";
import { MAINNET_IDENTITIES } from "../mainnet/identities.mjs";
import { loadAgentOpsCredentials } from "../mainnet/agentCredentials.mjs";
import { pickRpc } from "../networks/rpc.mjs";
import { MAINNET } from "../networks/profiles.mjs";

const { connect, keyStores } = nearAPI;

export async function createDecisionAuditPublisher(opts = {}) {
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
  const policy = MAINNET_IDENTITIES.policy;

  return {
    async publish(args) {
      try {
        const outcome = await agentAccount.functionCall({
          contractId: policy,
          methodName: "record_decision_cycle",
          args: {
            input: {
              ...args,
              proposed_amount_raw: args.proposed_amount_raw,
              fitted_amount_raw: args.fitted_amount_raw,
            },
          },
          gas: BigInt("30000000000000"),
          attachedDeposit: 0n,
        });
        const tx =
          outcome?.transaction_outcome?.id ||
          outcome?.transaction?.hash ||
          null;
        const logs = [];
        const receipts = outcome?.receipts_outcome || [];
        for (const r of receipts) {
          for (const line of r?.outcome?.logs || []) logs.push(line);
        }
        return { ok: Boolean(tx), tx_hash: tx, logs, outcome };
      } catch (e) {
        const msg = String(e.message || e);
        return {
          ok: false,
          error: msg.includes("MethodNotFound")
            ? "record_decision_cycle_not_deployed"
            : msg.slice(0, 400),
        };
      }
    },
  };
}
