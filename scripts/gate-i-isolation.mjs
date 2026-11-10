#!/usr/bin/env node
/**
 * Gate I1 — prove User B cannot administer / sign / withdraw for User A.
 * Does NOT touch nio-c-* demo accounts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNotDemo,
  connectWithAccounts,
  pickRpc,
  viewFunction,
} from "./lib/near-live.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "evidence", "live");

function failMsg(e) {
  return String(e?.message || e).slice(0, 500);
}

async function expectReject(label, fn) {
  try {
    const r = await fn();
    return {
      label,
      rejected: false,
      unexpected_ok: true,
      tx: r?.transaction?.hash || null,
    };
  } catch (e) {
    return { label, rejected: true, error: failMsg(e) };
  }
}

async function main() {
  const provision = JSON.parse(
    readFileSync(join(EVIDENCE, "gate-i-provision.json"), "utf8")
  );
  const a = provision.users.find((u) => u.tag === "a");
  const b = provision.users.find((u) => u.tag === "b");
  if (!a || !b) throw new Error("need users a and b in gate-i-provision.json");
  for (const id of [a.owner, a.policy, b.owner, b.policy, provision.agent]) {
    assertNotDemo(id);
  }

  const rpc = await pickRpc();
  const near = await connectWithAccounts(rpc, CREDS, [
    a.owner,
    b.owner,
    provision.agent,
  ]);
  const ownerA = await near.account(a.owner);
  const ownerB = await near.account(b.owner);
  const agent = await near.account(provision.agent);

  const pathA = await viewFunction(rpc, a.policy, "get_derivation_path");
  const pathB = await viewFunction(rpc, b.policy, "get_derivation_path");
  const signerA = await viewFunction(rpc, a.policy, "get_intents_signer_id");
  const signerB = await viewFunction(rpc, b.policy, "get_intents_signer_id");

  const checks = [];

  checks.push({
    label: "distinct_portfolio_ids",
    pass: a.portfolio_id !== b.portfolio_id,
    a: a.portfolio_id,
    b: b.portfolio_id,
  });
  checks.push({
    label: "distinct_derivation_paths",
    pass: pathA !== pathB,
    a: pathA,
    b: pathB,
  });
  checks.push({
    label: "distinct_evm_identities",
    pass:
      String(signerA).toLowerCase() !== String(signerB).toLowerCase() &&
      a.evm.toLowerCase() !== b.evm.toLowerCase(),
    a: signerA,
    b: signerB,
  });

  // B cannot set_policy on A
  checks.push(
    await expectReject("b_set_policy_on_a", () =>
      ownerB.functionCall({
        contractId: a.policy,
        methodName: "set_policy",
        args: {
          limits: {
            max_trade_value: "1",
            daily_turnover_limit: "1",
            max_pending_exposure: "1",
            max_slippage_bps: 1,
            allowed_assets: ["USDC"],
            allowed_destinations: [b.owner],
            valid_until: "1893456000000000000",
          },
          policy_hash: "attack",
          strategy_hash: "attack",
        },
        gas: BigInt("30000000000000"),
        attachedDeposit: 0n,
      })
    ).then((r) => ({ ...r, pass: r.rejected }))
  );

  // B cannot revoke A
  checks.push(
    await expectReject("b_revoke_a", () =>
      ownerB.functionCall({
        contractId: a.policy,
        methodName: "revoke",
        args: {},
        gas: BigInt("30000000000000"),
        attachedDeposit: 0n,
      })
    ).then((r) => ({ ...r, pass: r.rejected }))
  );

  // B cannot owner_request_withdraw_signature on A
  checks.push(
    await expectReject("b_withdraw_a", () =>
      ownerB.functionCall({
        contractId: a.policy,
        methodName: "owner_request_withdraw_signature",
        args: {
          operation_id: `attack-withdraw-${Date.now()}`,
          withdraw: {
            nonce: "0",
            gas_price: "1000000000",
            gas_limit: "100000",
            chain_id: "11155111",
            token_contract: "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2",
            to: b.evm,
            amount: "1",
          },
        },
        gas: BigInt("100000000000000"),
        attachedDeposit: 1n,
      })
    ).then((r) => ({ ...r, pass: r.rejected }))
  );

  // Agent proposing on A with B's destination in withdraw is already covered;
  // prove agent cannot call owner withdraw either
  checks.push(
    await expectReject("agent_cannot_owner_withdraw_a", () =>
      agent.functionCall({
        contractId: a.policy,
        methodName: "owner_request_withdraw_signature",
        args: {
          operation_id: `agent-attack-${Date.now()}`,
          withdraw: {
            nonce: "0",
            gas_price: "1000000000",
            gas_limit: "100000",
            chain_id: "11155111",
            token_contract: "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2",
            to: a.evm,
            amount: "1",
          },
        },
        gas: BigInt("100000000000000"),
        attachedDeposit: 1n,
      })
    ).then((r) => ({ ...r, pass: r.rejected }))
  );

  // Positive control: owner A can pause (admin self)
  let pauseTx = null;
  try {
    const p = await ownerA.functionCall({
      contractId: a.policy,
      methodName: "pause",
      args: {},
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
    pauseTx = p.transaction.hash;
    checks.push({ label: "a_can_pause_self", pass: true, tx: pauseTx });
  } catch (e) {
    checks.push({ label: "a_can_pause_self", pass: false, error: failMsg(e) });
  }

  // While paused, agent trade path must fail
  checks.push(
    await expectReject("agent_propose_while_paused", () =>
      agent.functionCall({
        contractId: a.policy,
        methodName: "propose_trade",
        args: {
          operation_id: `paused-${Date.now()}`,
          amount_in: "1",
          asset_in: "USDC",
          asset_out: "NEAR",
          destination: a.owner,
          min_amount_out: "1",
          intent_deadline: "1893456000000000000",
          intent_payload: "x",
          payload_commitment: "00".repeat(32),
        },
        gas: BigInt("50000000000000"),
        attachedDeposit: 0n,
      })
    ).then((r) => ({ ...r, pass: r.rejected }))
  );

  const pass = checks.every((c) => c.pass);
  const out = {
    gate: "I1-isolation",
    network: "testnet",
    demo_untouched: true,
    identities: { a, b, agent: provision.agent },
    checks,
    verdict: pass ? "PASS" : "FAIL",
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(EVIDENCE, "gate-i-isolation.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
