/**
 * Live mainnet EVM balance reads for Ethereum / Arbitrum / Base.
 * Never invents balances.
 */
import { MAINNET_EVM_RPCS, MAINNET_USDC } from "./identities.mjs";

async function ethRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

function padAddress(addr) {
  return String(addr || "")
    .replace(/^0x/i, "")
    .toLowerCase()
    .padStart(64, "0");
}

export async function evmNativeBalance(rpcUrl, address) {
  const j = await ethRpc(rpcUrl, "eth_getBalance", [address, "latest"]);
  if (j.error) {
    return { ok: false, reason: "rpc_error", detail: j.error.message || "error" };
  }
  const wei = BigInt(j.result || "0x0");
  return {
    ok: true,
    wei: wei.toString(),
    ether: Number(wei) / 1e18,
    verified: true,
  };
}

export async function evmErc20Balance(rpcUrl, token, holder) {
  const data = "0x70a08231" + padAddress(holder);
  const j = await ethRpc(rpcUrl, "eth_call", [{ to: token, data }, "latest"]);
  if (j.error) {
    return { ok: false, reason: "rpc_error", detail: j.error.message || "error" };
  }
  const raw = BigInt(j.result && j.result !== "0x" ? j.result : "0x0");
  return {
    ok: true,
    raw: raw.toString(),
    // USDC 6 decimals
    ui: Number(raw) / 1e6,
    verified: true,
    token,
  };
}

/**
 * @param {string} evmAddress checksum/lower 0x address (MPC derived)
 */
export async function fetchFourChainEvmBalances(evmAddress, opts = {}) {
  const addr = String(evmAddress || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    return { ok: false, reason: "invalid_evm_address" };
  }
  const rpcs = { ...MAINNET_EVM_RPCS, ...(opts.rpcs || {}) };
  const usdc = { ...MAINNET_USDC, ...(opts.usdc || {}) };

  const chains = ["ethereum", "arbitrum", "base"];
  const out = {};
  for (const chain of chains) {
    const rpc = rpcs[chain];
    // eslint-disable-next-line no-await-in-loop
    const native = await evmNativeBalance(rpc, addr);
    // eslint-disable-next-line no-await-in-loop
    const token = await evmErc20Balance(rpc, usdc[chain], addr);
    out[chain] = {
      chain,
      address: addr,
      rpc_host: (() => {
        try {
          return new URL(rpc).host;
        } catch {
          return "invalid_rpc";
        }
      })(),
      native_wei: native.ok ? native.wei : null,
      native_ether: native.ok ? native.ether : null,
      native_ok: native.ok,
      usdc_raw: token.ok ? token.raw : null,
      usdc_ui: token.ok ? token.ui : null,
      usdc_ok: token.ok,
      usdc_contract: usdc[chain],
      verified: Boolean(native.ok && token.ok),
    };
  }
  return {
    ok: true,
    address: addr,
    chains: out,
    any_usdc: Object.values(out).some((c) => c.usdc_ok && BigInt(c.usdc_raw || "0") > 0n),
    any_gas: Object.values(out).some((c) => c.native_ok && BigInt(c.native_wei || "0") > 0n),
  };
}
