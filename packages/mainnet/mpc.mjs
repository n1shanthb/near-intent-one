/**
 * Mainnet Chain Signatures helpers — v1.signer only.
 * Derivation ≠ signature. Never treat a derived address as a completed sign.
 */
import {
  MAINNET,
  assertNetworkIsolation,
  DOMAIN_SECP256K1,
} from "../networks/profiles.mjs";
import { pickRpc, viewFunction } from "../networks/rpc.mjs";
import { evmAddressFromNearSecpKey } from "../intents-codec/eip191.mjs";

export function portfolioDerivationPath(portfolioId) {
  const id = String(portfolioId || "").trim();
  if (!id || id.includes("/")) {
    throw new Error("invalid_portfolio_id");
  }
  return `${MAINNET.derivationPathPrefix}/${id}`;
}

export async function mainnetMpcPublicKey(opts = {}) {
  assertNetworkIsolation(MAINNET, { allowMainnet: true });
  const rpc = opts.rpc || (await pickRpc(MAINNET.near.rpcs));
  const signer = opts.signer || MAINNET.mpc.signer;
  const pk = await viewFunction(rpc, signer, "public_key", {});
  return {
    network: "mainnet",
    signer,
    rpc,
    public_key: typeof pk === "string" ? pk : pk?.public_key || pk,
    status: "VERIFIED_ON_MAINNET_READ",
    note: "Root MPC public key view — not a user signature",
  };
}

/**
 * Derive ECDSA address for (policyContract, path) on mainnet MPC.
 * predecessor MUST be the policy contract account that will call sign().
 */
export async function deriveMainnetEvmAddress({
  policyContract,
  portfolioId,
  path,
  rpc: rpcOpt,
} = {}) {
  assertNetworkIsolation(MAINNET, { allowMainnet: true });
  if (!policyContract || !String(policyContract).endsWith(".near")) {
    throw new Error("policy_contract_must_be_mainnet_near_account");
  }
  if (String(policyContract).startsWith(MAINNET.demoPrefix)) {
    throw new Error("demo_policy_banned_on_mainnet");
  }
  const derPath = path || portfolioDerivationPath(portfolioId);
  const rpc = rpcOpt || (await pickRpc(MAINNET.near.rpcs));
  let key = await viewFunction(rpc, MAINNET.mpc.signer, "derived_public_key", {
    path: derPath,
    predecessor: policyContract,
    domain_id: DOMAIN_SECP256K1,
  });
  if (typeof key === "object" && key !== null) {
    key = key.public_key || key;
  }
  if (typeof key !== "string") {
    throw new Error(`unexpected_derived_public_key:${JSON.stringify(key)}`);
  }
  const evm = evmAddressFromNearSecpKey(key).toLowerCase();
  return {
    network: "mainnet",
    signer: MAINNET.mpc.signer,
    domain_id: DOMAIN_SECP256K1,
    path: derPath,
    predecessor: policyContract,
    near_secp_key: key,
    evm_address: evm,
    status: "DERIVED_ADDRESS_ONLY",
    note: "Derived address is NOT a completed mainnet signature request",
  };
}

/** Gas / deposit checklist for a future sign() call — no broadcast here. */
export function mainnetSignRequirements() {
  return {
    signer: MAINNET.mpc.signer,
    attached_deposit: "1 yoctoNEAR",
    recommended_gas_tgas: 15,
    domain_id: DOMAIN_SECP256K1,
    payload: "Ecdsa(32-byte hex hash)",
    duplicate_policy:
      "Same caller/domain/path/payload while pending is queued; queue bounded",
    funded_sign_default: "OFF (NIO_MAINNET_ALLOW_SIGN=0)",
  };
}
