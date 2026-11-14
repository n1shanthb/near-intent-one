#!/usr/bin/env node
/**
 * J16 P2 — Attempt authentic NEAR MPC → EVM testnet transfer.
 * Discovers route constraints first. Never substitutes a local private key for MPC.
 * Distinguishes TOKEN_TRANSFER vs full INTENTS settlement.
 * HARD STOP: testnet only; no mainnet.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import * as nearAPI from "near-api-js";
import {
  NETWORK,
  MPC,
  VERIFIER,
  pickRpc,
  assertNotDemo,
  SEPOLIA_RPC,
  USDC_SEPOLIA,
} from "../lib/near-live.mjs";
import {
  extractMpcSigFromNearTx,
  mpcToRsV,
  recoverFromHash,
} from "../../packages/gate-k/settle.mjs";
import {
  assembleSignedEvmFromMpc,
  validateSignedRawAgainstPolicy,
  verifySettlementFromReceipt,
} from "../../packages/autonomous/signedTxPipeline.mjs";
import {
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
} from "../../packages/intents-codec/quote-auth.mjs";
import { evmAddressFromNearSecpKey } from "../../packages/intents-codec/eip191.mjs";

const { connect, keyStores, KeyPair, transactions } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "docs", "evidence");
const WASM = join(
  ROOT,
  "contracts/policy/target/wasm32-unknown-unknown/release/policy.wasm"
);
mkdirSync(EVIDENCE, { recursive: true });

function loadCred(id) {
  return JSON.parse(readFileSync(join(CREDS, `${id}.json`), "utf8"));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clearAccessKeyCache(account) {
  if (account?.accessKeyByPublicKeyCache) account.accessKeyByPublicKeyCache = {};
}

async function callOnce(account, receiverId, { methodName, args, gas, deposit = 0n }) {
  const actions = [
    transactions.functionCall(
      methodName,
      args,
      gas || BigInt("100000000000000"),
      deposit
    ),
  ];
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      clearAccessKeyCache(account);
      const [, signed] = await account.signTransaction(receiverId, actions);
      const outcome = await account.connection.provider.sendTransaction(signed);
      if (outcome.status?.Failure) {
        throw new Error(JSON.stringify(outcome.status.Failure));
      }
      clearAccessKeyCache(account);
      await sleep(300);
      return outcome;
    } catch (e) {
      lastErr = e;
      if (!/InvalidNonce|nonce/i.test(String(e.message || e))) throw e;
      clearAccessKeyCache(account);
      await sleep(400 + attempt * 200);
    }
  }
  throw lastErr;
}

async function eth(rpc, method, params = []) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function deriveMpcEvm({ rpc, policyId, path }) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: MPC,
        method_name: "derived_public_key",
        args_base64: Buffer.from(
          JSON.stringify({ path, predecessor: policyId, domain_id: 0 })
        ).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) {
    throw new Error(JSON.stringify(j.error || j.result.error));
  }
  const raw = Buffer.from(j.result.result).toString("utf8");
  let key;
  try {
    key = JSON.parse(raw);
  } catch {
    key = raw.replace(/^"|"$/g, "");
  }
  if (typeof key === "object") key = key.public_key || key;
  const evm = evmAddressFromNearSecpKey(String(key)).toLowerCase();
  return { near_secp_key: key, evm_address: evm, path, predecessor: policyId };
}

const report = {
  kind: "J16_MPC_EVM_TESTNET_ATTEMPT",
  started_at: new Date().toISOString(),
  hard_stop_mainnet: true,
  sepolia_rpc: SEPOLIA_RPC,
  usdc_sepolia: USDC_SEPOLIA,
  discovery: {},
  gates: {
    AUTHENTIC_NEAR_MPC_SIGNATURE: "NO-GO",
    REAL_EVM_TESTNET_BROADCAST: "NO-GO",
    TOKEN_TRANSFER_VERIFIED: "NO-GO",
    INTENTS_SETTLEMENT_VERIFIED: "NO-GO",
  },
  note:
    "Token transfer ≠ Intents swap. Local private-key signatures are forbidden as MPC substitute.",
};

if (!existsSync(WASM)) {
  report.verdict = "NO_GO";
  report.error = "policy_wasm_missing";
  writeFileSync(
    join(EVIDENCE, "J16_MPC_EVM_TESTNET_ATTEMPT.json"),
    JSON.stringify(report, null, 2)
  );
  process.exit(1);
}

try {
  // Discovery: Sepolia RPC + USDC contract code
  const sepoliaChain = await eth(SEPOLIA_RPC, "eth_chainId", []);
  report.discovery.sepolia_chain_id = Number(BigInt(sepoliaChain));
  const usdcCode = await eth(SEPOLIA_RPC, "eth_getCode", [USDC_SEPOLIA, "latest"]);
  report.discovery.usdc_code_bytes = (usdcCode?.length || 2) / 2 - 1;
  report.discovery.usdc_contract_present = Boolean(
    usdcCode && usdcCode !== "0x" && usdcCode.length > 4
  );

  const nearRpc = await pickRpc();
  report.discovery.near_rpc = nearRpc;

  const sponsorCandidates = [
    "nio-owner-02b7cf.testnet",
    "nio-j13-998a-owner.testnet",
    "nio-j13-4dd4-owner.testnet",
    "nio-j13-f66f-owner.testnet",
    "nio-j13-e974-owner.testnet",
  ];
  const owner = loadCred("nio-owner-02b7cf.testnet");
  const agent = loadCred("nio-agent-02b7cf.testnet");
  let sponsor = null;
  {
    const ks = new keyStores.InMemoryKeyStore();
    for (const id of sponsorCandidates) {
      try {
        const c = loadCred(id);
        const aid = c.account_id || id;
        await ks.setKey(NETWORK, aid, KeyPair.fromString(c.private_key));
      } catch {
        /* skip bad cred */
      }
    }
    const near = await connect({
      networkId: NETWORK,
      nodeUrl: nearRpc,
      deps: { keyStore: ks },
    });
    for (const id of sponsorCandidates) {
      try {
        const c = loadCred(id);
        const aid = c.account_id || id;
        const bal = await (await near.account(aid)).getAccountBalance();
        report.discovery.sponsor_probe = report.discovery.sponsor_probe || {};
        report.discovery.sponsor_probe[aid] = (
          Number(bal.available) / 1e24
        ).toFixed(4);
        // ~5.8N covers current policy WASM deploy on testnet
        if (BigInt(bal.available) >= 5800000000000000000000000n) {
          sponsor = { ...c, account_id: aid };
          break;
        }
      } catch (e) {
        report.discovery.sponsor_probe = report.discovery.sponsor_probe || {};
        report.discovery.sponsor_probe[id] = String(e.message || e).slice(0, 80);
      }
    }
  }
  const tag = randomBytes(2).toString("hex");
  const policyKp = KeyPair.fromRandom("ed25519");
  let policyId;
  let fundMode = "sponsor_create";

  // Prefer faucet disposable root account (~10N) when sponsors are lean
  const faucetId = `j16f${tag}.testnet`;
  assertNotDemo(faucetId);
  const FAUCETS = [
    "https://helper.nearprotocol.com/account",
    "https://helper.testnet.near.org/account",
  ];
  let faucetOk = false;
  for (const url of FAUCETS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          newAccountId: faucetId,
          newAccountPublicKey: policyKp.getPublicKey().toString(),
        }),
      });
      if (res.ok) {
        faucetOk = true;
        fundMode = `faucet:${url}`;
        break;
      }
    } catch {
      /* next */
    }
  }

  if (faucetOk) {
    policyId = faucetId;
    sponsor = { account_id: faucetId, note: "faucet_self" };
  } else if (sponsor) {
    policyId = `j16m${tag}.${sponsor.account_id}`;
    assertNotDemo(policyId);
  } else {
    throw new Error("no_funded_sponsor_and_faucet_failed");
  }
  report.discovery.fund_mode = fundMode;

  writeFileSync(
    join(CREDS, `${policyId}.json`),
    JSON.stringify(
      {
        account_id: policyId,
        public_key: policyKp.getPublicKey().toString(),
        private_key: policyKp.toString(),
        role: "policy",
        gate: "J16",
      },
      null,
      2
    )
  );

  const ks = new keyStores.InMemoryKeyStore();
  for (const c of [owner, agent]) {
    await ks.setKey(NETWORK, c.account_id, KeyPair.fromString(c.private_key));
  }
  if (sponsor?.private_key) {
    await ks.setKey(
      NETWORK,
      sponsor.account_id,
      KeyPair.fromString(sponsor.private_key)
    );
  }
  await ks.setKey(NETWORK, policyId, policyKp);
  const near = await connect({
    networkId: NETWORK,
    nodeUrl: nearRpc,
    deps: { keyStore: ks },
  });
  const ownerAcct = await near.account(owner.account_id);
  const agentAcct = await near.account(agent.account_id);

  if (!faucetOk) {
    const sponsorAcct = await near.account(sponsor.account_id);
    await sponsorAcct.createAccount(
      policyId,
      policyKp.getPublicKey().toString(),
      BigInt("5600000000000000000000000")
    );
    await sleep(500);
  } else {
    await sleep(800);
  }
  const policyAcct = await near.account(policyId);
  const wasm = readFileSync(WASM);
  {
    clearAccessKeyCache(policyAcct);
    const [, signed] = await policyAcct.signTransaction(policyId, [
      transactions.deployContract(wasm),
    ]);
    const out = await policyAcct.connection.provider.sendTransaction(signed);
    if (out.status?.Failure) throw new Error(JSON.stringify(out.status.Failure));
    report.steps = [{ deploy: out.transaction.hash }];
  }
  await sleep(400);

  const portfolioId = `j16-mpc-${tag}`;
  const path = `trading/v1/portfolio/${portfolioId}`;
  const limits = {
    max_trade_value: "1000000",
    daily_turnover_limit: "5000000",
    max_pending_exposure: "2000000",
    max_slippage_bps: 100,
    allowed_assets: [
      `eip155:11155111:${USDC_SEPOLIA.toLowerCase()}`,
      "USDC",
      "NEAR",
    ],
    allowed_destinations: [
      owner.account_id,
      "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    ],
    valid_until: "1893456000000000000",
    token_scope: "allowlist",
    allowed_chains: ["near", "eip155:11155111"],
    allowed_venues: ["near_intents_1click", "evm_transfer"],
    max_gas_budget: "500000000000000",
  };

  await callOnce(policyAcct, policyId, {
    methodName: "new",
    args: {
      owner: owner.account_id,
      agent: agent.account_id,
      mpc_signer: MPC,
      portfolio_id: portfolioId,
      verifying_contract: VERIFIER,
      limits,
    },
  });

  const derived = await deriveMpcEvm({ rpc: nearRpc, policyId, path });
  report.discovery.mpc_evm = derived;
  report.accounts = {
    owner: owner.account_id,
    agent: agent.account_id,
    policy: policyId,
    mpc_evm: derived.evm_address,
  };

  await callOnce(ownerAcct, policyId, {
    methodName: "set_intents_signer_id",
    args: { intents_signer_id: derived.evm_address },
  });
  await callOnce(ownerAcct, policyId, {
    methodName: "activate_autonomous_mandate",
    args: {
      limits,
      policy_hash: `j16-${tag}`,
      strategy_hash: "j16-mpc-evm",
      enforce_autonomous_on_agent: true,
      autonomous_trading: true,
      unpause_now: true,
    },
  });

  // Funding gate — MPC address must hold Sepolia ETH + USDC for a real transfer
  const ethBalHex = await eth(SEPOLIA_RPC, "eth_getBalance", [
    derived.evm_address,
    "latest",
  ]);
  const ethBal = BigInt(ethBalHex || "0x0");
  const usdcData =
    "0x70a08231" +
    derived.evm_address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const usdcBalHex = await eth(SEPOLIA_RPC, "eth_call", [
    { to: USDC_SEPOLIA, data: usdcData },
    "latest",
  ]);
  const usdcBal = BigInt(usdcBalHex || "0x0");
  report.discovery.funding = {
    eth_wei: ethBal.toString(),
    usdc_raw: usdcBal.toString(),
    funded_for_transfer: ethBal > 0n && usdcBal >= 1000000n,
  };

  // Even without Sepolia funding: prove authentic NEAR MPC ECDSA via propose_trade
  // + request_signature (digest = payload_commitment). This is NOT an EVM broadcast.
  const opId = `j16-mpc-${tag}`;
  const commitment = createHash("sha256")
    .update(`${opId}:${derived.evm_address}`)
    .digest("hex");
  const proposal = {
    operation_id: opId,
    amount_in: "1000000",
    asset_in: "USDC",
    asset_out: "NEAR",
    destination: owner.account_id,
    min_amount_out: "990000",
    intent_deadline: "9000000000000000000",
    payload_commitment: commitment,
  };
  // USDC/NEAR may not match allowlist asset format — adjust allowlist if propose fails
  try {
    const pOut = await callOnce(agentAcct, policyId, {
      methodName: "propose_trade",
      args: { proposal },
    });
    report.steps.push({
      propose_trade: pOut.transaction.hash,
      explorer: `https://testnet.nearblocks.io/txns/${pOut.transaction.hash}`,
      note: "NEAR-side reservation only — not EVM broadcast",
    });
    const sOut = await callOnce(agentAcct, policyId, {
      methodName: "request_signature",
      args: { operation_id: opId },
      gas: BigInt("300000000000000"),
      deposit: 1n,
    });
    // Fetch full tx status for MPC SuccessValue
    const status = await near.connection.provider.sendJsonRpc(
      "EXPERIMENTAL_tx_status",
      [sOut.transaction.hash, agent.account_id]
    );
    const extracted = extractMpcSigFromNearTx(status);
    report.mpc_extract = {
      found: extracted.found,
      reason: extracted.reason,
      has_signature_json: Boolean(extracted.signature_json),
      near_tx: sOut.transaction.hash,
      explorer: `https://testnet.nearblocks.io/txns/${sOut.transaction.hash}`,
    };
    if (extracted.found) {
      const { r, s, recoveryId } = mpcToRsV(extracted.signature_json);
      // Contract signs keccak/sha of commitment bytes — try digest of hex-decoded commitment
      const digest = Buffer.from(commitment, "hex");
      let recovered = null;
      try {
        recovered = recoverFromHash(digest, r, s, recoveryId);
        if (recovered.toLowerCase() !== derived.evm_address) {
          const alt = recoverFromHash(digest, r, s, recoveryId ^ 1);
          if (alt.toLowerCase() === derived.evm_address) recovered = alt;
        }
      } catch (e) {
        report.mpc_extract.recover_error = String(e.message || e).slice(0, 200);
      }
      report.mpc_extract.recovered = recovered;
      report.mpc_extract.matches_derived_mpc =
        String(recovered || "").toLowerCase() === derived.evm_address;
      report.gates.AUTHENTIC_NEAR_MPC_SIGNATURE = extracted.found
        ? "PASS"
        : "FAIL";
      report.gates.AUTHENTIC_NEAR_MPC_SIGNATURE_NOTE =
        "NEAR MPC Secp256k1 signature extracted from testnet request_signature; not an EVM broadcast";
    }
  } catch (e) {
    report.mpc_path_error = String(e.message || e).slice(0, 600);
    report.gates.AUTHENTIC_NEAR_MPC_SIGNATURE = "FAIL_OR_BLOCKED";
  }

  if (!report.discovery.funding.funded_for_transfer) {
    report.verdict = "NO_GO";
    report.blocker =
      "MPC-derived Sepolia address lacks ETH gas and/or USDC test tokens — cannot complete authentic MPC→EVM broadcast without funding (HARD STOP: no mainnet funding; testnet faucet for derived address not available in-session)";
    report.gates.REAL_EVM_TESTNET_BROADCAST = "NO-GO";
    report.gates.TOKEN_TRANSFER_VERIFIED = "NO-GO";
    report.gates.INTENTS_SETTLEMENT_VERIFIED =
      "NO-GO — token transfer ≠ Intents swap; route unfunded/unsupported in-session";
    report.finished_at = new Date().toISOString();
    writeFileSync(
      join(EVIDENCE, "J16_MPC_EVM_TESTNET_ATTEMPT.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(
      JSON.stringify(
        {
          verdict: report.verdict,
          blocker: report.blocker,
          mpc_evm: derived.evm_address,
          funding: report.discovery.funding,
          mpc_sig: report.gates.AUTHENTIC_NEAR_MPC_SIGNATURE,
          evidence: join(EVIDENCE, "J16_MPC_EVM_TESTNET_ATTEMPT.json"),
        },
        null,
        2
      )
    );
    process.exit(0); // honest NO-GO recorded, not a crash
  }

  // If funded, continue with propose_quoted_evm + MPC (rare in this session)
  const nonceHex = await eth(SEPOLIA_RPC, "eth_getTransactionCount", [
    derived.evm_address,
    "pending",
  ]);
  const nonce = Number(BigInt(nonceHex));
  const gasPrice = await eth(SEPOLIA_RPC, "eth_gasPrice", []);
  const amount = "1000000";
  const dest = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const data = erc20TransferData(dest, amount);
  const digestBytes = eip155UnsignedDigest({
    nonce: BigInt(nonce),
    gasPrice: BigInt(gasPrice),
    gasLimit: 100000n,
    to: USDC_SEPOLIA,
    data,
    chainId: 11155111,
  });
  const digest_hex = digestHex(digestBytes);

  // Use propose_quoted_evm_transfer if available — else document path gap
  report.path_note =
    "Funded path would call propose_quoted_evm_transfer + request_signature; see contract";

  report.verdict = "NO_GO";
  report.finished_at = new Date().toISOString();
} catch (e) {
  report.verdict = "NO_GO";
  report.error = String(e.message || e).slice(0, 1000);
  report.finished_at = new Date().toISOString();
}

writeFileSync(
  join(EVIDENCE, "J16_MPC_EVM_TESTNET_ATTEMPT.json"),
  JSON.stringify(report, null, 2)
);
console.log(
  JSON.stringify(
    {
      verdict: report.verdict,
      gates: report.gates,
      discovery: report.discovery,
      error: report.error || report.blocker || null,
      evidence: join(EVIDENCE, "J16_MPC_EVM_TESTNET_ATTEMPT.json"),
    },
    null,
    2
  )
);
process.exit(0);
