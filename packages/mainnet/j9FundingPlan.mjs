/**
 * Consolidated J9 funding plan from live verified balances.
 * Never moves funds. Never fabricates quotes/gas.
 */
import { MAINNET_IDENTITIES, MAINNET_USDC, MAINNET_EVM_RPCS } from "./identities.mjs";
import { evmErc20Balance, evmNativeBalance } from "./evmBalances.mjs";
import { fetchEthereumGasPrice, evaluateEthereumGasEconomics } from "./ethereumFunding.mjs";
import { fetchBaseGasPrice, evaluateBaseGasEconomics, chooseAffordableUsdcAmount } from "./baseFunding.mjs";
import { checkNearFtStorageRegistered } from "./canarySettlement.mjs";
import { NEAR_NATIVE_USDC_CONTRACT } from "./canaryRouteProfiles.mjs";
import { createViewOnlyPolicyAdapters } from "./canaryRecovery.mjs";
import { GAS_ASSUMPTIONS } from "./j5_2.quoteScan.mjs";

const MPC = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
const OWNER = MAINNET_IDENTITIES.owner;

function usdc(n) {
  return Number(n) / 1e6;
}

/**
 * Build one coordinated funding checklist for Mission 1 + Mission 2.
 */
export async function buildJ9FundingPlan({
  env = process.env,
  ethUsdHint = 3200,
  m1AmountRaw = 1_000_000n,
  m2PreferredRaw = 1_000_000n,
  deps = {},
} = {}) {
  const a =
    deps.policyAdapters || (await createViewOnlyPolicyAdapters({ env }));

  const [
    ethNative,
    ethUsdc,
    baseNative,
    baseUsdc,
    arbNative,
    arbUsdc,
    ethGas,
    baseGas,
    storage,
  ] = await Promise.all([
    deps.ethNative || evmNativeBalance(MAINNET_EVM_RPCS.ethereum, MPC),
    deps.ethUsdc || evmErc20Balance(MAINNET_EVM_RPCS.ethereum, MAINNET_USDC.ethereum, MPC),
    deps.baseNative || evmNativeBalance(MAINNET_EVM_RPCS.base, MPC),
    deps.baseUsdc || evmErc20Balance(MAINNET_EVM_RPCS.base, MAINNET_USDC.base, MPC),
    deps.arbNative || evmNativeBalance(MAINNET_EVM_RPCS.arbitrum, MPC),
    deps.arbUsdc || evmErc20Balance(MAINNET_EVM_RPCS.arbitrum, MAINNET_USDC.arbitrum, MPC),
    deps.ethGas || fetchEthereumGasPrice(MAINNET_EVM_RPCS.ethereum),
    deps.baseGas || fetchBaseGasPrice(MAINNET_EVM_RPCS.base),
    deps.storage ||
      checkNearFtStorageRegistered({
        accountId: OWNER,
        tokenContract: NEAR_NATIVE_USDC_CONTRACT,
        rpcUrl: a.rpc,
      }),
  ]);

  const ethFee = evaluateEthereumGasEconomics({
    gasPriceWei: ethGas.ok ? ethGas.gas_price_wei : GAS_ASSUMPTIONS.ethereum.max_gas_price_wei,
    gasLimit: 100_000n, // typical ERC-20 transfer headroom
    tradeAmountRaw: m1AmountRaw,
    ethUsdHint,
  });
  const baseFee = evaluateBaseGasEconomics({
    gasPriceWei: baseGas.ok ? baseGas.gas_price_wei : GAS_ASSUMPTIONS.base.max_gas_price_wei,
    gasLimit: 100_000n,
    tradeAmountRaw: m2PreferredRaw,
    ethUsdHint,
  });

  const m2Afford = chooseAffordableUsdcAmount({
    balanceRaw: baseUsdc.raw || "0",
    requestedMaxRaw: m2PreferredRaw,
    candidates: [1_000_000n, 500_000n, 250_000n],
  });

  const ethUsdcHave = BigInt(ethUsdc.raw || 0);
  const ethUsdcNeed = m1AmountRaw;
  const ethUsdcTopUp = ethUsdcHave >= ethUsdcNeed ? 0n : ethUsdcNeed - ethUsdcHave;

  // Gas buffers: 3x estimated fee, minimum floors
  const ethGasNeedWei = BigInt(ethFee.fee_wei) * 3n;
  const ethGasFloor = 500_000_000_000_000n; // 0.0005 ETH
  const ethGasTarget = ethGasNeedWei > ethGasFloor ? ethGasNeedWei : ethGasFloor;
  const ethGasHave = BigInt(ethNative.wei || 0);
  const ethGasTopUp = ethGasHave >= ethGasTarget ? 0n : ethGasTarget - ethGasHave;

  const baseGasNeedWei = BigInt(baseFee.fee_wei) * 5n;
  const baseGasFloor = 100_000_000_000_000n; // 0.0001 ETH on Base
  const baseGasTarget = baseGasNeedWei > baseGasFloor ? baseGasNeedWei : baseGasFloor;
  const baseGasHave = BigInt(baseNative.wei || 0);
  const baseGasTopUp = baseGasHave >= baseGasTarget ? 0n : baseGasTarget - baseGasHave;

  const baseUsdcHave = BigInt(baseUsdc.raw || 0);
  let m2Amount = m2Afford.ok ? BigInt(m2Afford.amount_raw) : 0n;
  let baseUsdcTopUp = 0n;
  let m2Strategy = "reuse_existing_base_usdc";
  if (!m2Afford.ok) {
    baseUsdcTopUp = 1_000_000n - baseUsdcHave;
    m2Amount = 1_000_000n;
    m2Strategy = "top_up_to_1_usdc";
  } else if (m2Amount < 1_000_000n) {
    m2Strategy = `reduced_canary_${m2Afford.amount_usdc}_usdc_no_topup`;
  }

  const storageNeedYocto = storage.registered
    ? 0n
    : BigInt(storage.storage_bounds?.min || "1250000000000000000000");

  const rows = [
    {
      chain: "ethereum",
      asset: "USDC",
      recipient: MPC,
      current_raw: ethUsdc.raw,
      current_ui: ethUsdc.ui,
      for_canary: "Mission1 Eth→NEAR",
      amount_needed_raw: ethUsdcNeed.toString(),
      amount_needed_ui: usdc(ethUsdcNeed),
      top_up_raw: ethUsdcTopUp.toString(),
      top_up_ui: usdc(ethUsdcTopUp),
      buffer_note: "exact 1 USDC canary — no excess USDC required",
      source_of_funds: "owner EOA / exchange → MPC Ethereum",
      reusable: ethUsdcHave > 0n,
    },
    {
      chain: "ethereum",
      asset: "ETH",
      recipient: MPC,
      current_raw: ethNative.wei,
      current_ui: ethNative.ether,
      for_canary: "Mission1 gas",
      amount_needed_raw: ethGasTarget.toString(),
      amount_needed_ui: Number(ethGasTarget) / 1e18,
      top_up_raw: ethGasTopUp.toString(),
      top_up_ui: Number(ethGasTopUp) / 1e18,
      buffer_note: `3× live fee est (${ethFee.fee_eth} ETH ≈ $${ethFee.fee_usd_approx?.toFixed?.(2)}) with 0.0005 ETH floor`,
      estimated_network_cost_usd: ethFee.fee_usd_approx,
      source_of_funds: "owner EOA → MPC Ethereum",
      reusable: ethGasHave > 0n,
    },
    {
      chain: "base",
      asset: "USDC",
      recipient: MPC,
      current_raw: baseUsdc.raw,
      current_ui: baseUsdc.ui,
      for_canary: "Mission2 Base→Eth",
      amount_needed_raw: m2Amount.toString(),
      amount_needed_ui: usdc(m2Amount),
      top_up_raw: baseUsdcTopUp.toString(),
      top_up_ui: usdc(baseUsdcTopUp),
      buffer_note: m2Strategy,
      j8b_leftover_rechecked: true,
      source_of_funds:
        baseUsdcTopUp === 0n
          ? "reuse MPC Base USDC from J8B settlement (verified live)"
          : "owner → MPC Base USDC",
      reusable: baseUsdcHave > 0n,
    },
    {
      chain: "base",
      asset: "ETH",
      recipient: MPC,
      current_raw: baseNative.wei,
      current_ui: baseNative.ether,
      for_canary: "Mission2 gas",
      amount_needed_raw: baseGasTarget.toString(),
      amount_needed_ui: Number(baseGasTarget) / 1e18,
      top_up_raw: baseGasTopUp.toString(),
      top_up_ui: Number(baseGasTopUp) / 1e18,
      buffer_note: `5× live Base fee est (${baseFee.fee_eth} ETH) with 0.0001 ETH floor`,
      estimated_network_cost_usd: baseFee.fee_usd_approx,
      source_of_funds: "owner EOA → MPC Base",
      reusable: baseGasHave > 0n,
    },
    {
      chain: "near",
      asset: "NEAR (storage_deposit)",
      recipient: OWNER,
      current_raw: storage.registered ? "registered" : "unregistered",
      current_ui: storage.registered ? 1 : 0,
      for_canary: "Mission1 NEAR USDC receive",
      amount_needed_raw: storageNeedYocto.toString(),
      amount_needed_ui: Number(storageNeedYocto) / 1e24,
      top_up_raw: storageNeedYocto.toString(),
      top_up_ui: Number(storageNeedYocto) / 1e24,
      buffer_note: "exact storage_balance_bounds.min for NEAR native USDC NEP-141",
      token_contract: NEAR_NATIVE_USDC_CONTRACT,
      source_of_funds: `${OWNER} signs storage_deposit (Ledger) — uses account NEAR balance`,
      reusable: false,
      storage_registered: Boolean(storage.registered),
    },
    {
      chain: "arbitrum",
      asset: "USDC/ETH",
      recipient: MPC,
      current_raw_usdc: arbUsdc.raw,
      current_ui_usdc: arbUsdc.ui,
      current_eth: arbNative.ether,
      for_canary: "none in J9 funded scope",
      amount_needed_raw: "0",
      top_up_raw: "0",
      buffer_note: "J8B complete — no Arb top-up for scoped missions",
      source_of_funds: "n/a",
      reusable: true,
    },
  ];

  const totals = {
    eth_usdc_top_up: usdc(ethUsdcTopUp),
    eth_gas_top_up_eth: Number(ethGasTopUp) / 1e18,
    eth_gas_top_up_usd_approx: (Number(ethGasTopUp) / 1e18) * ethUsdHint,
    base_usdc_top_up: usdc(baseUsdcTopUp),
    base_gas_top_up_eth: Number(baseGasTopUp) / 1e18,
    near_storage_near: Number(storageNeedYocto) / 1e24,
    m2_proposed_amount_usdc: usdc(m2Amount),
    m2_strategy: m2Strategy,
  };

  const blockers = [];
  if (ethUsdcTopUp > 0n) blockers.push("need_ethereum_usdc");
  if (ethGasTopUp > 0n) blockers.push("need_ethereum_eth_gas");
  if (baseGasTopUp > 0n) blockers.push("need_base_eth_gas");
  if (baseUsdcTopUp > 0n) blockers.push("need_base_usdc_topup");
  if (!storage.registered) blockers.push("need_near_usdc_storage_deposit");

  /**
   * Live 1Click Base→Eth quotes embed ~0.30 USDC withdrawFee. Policy floor is
   * 99% of amount_in (max_slippage_bps=100) while max_trade_value=5 USDC.
   * amount_out ≈ amount_in - 300000 never clears the floor at ≤5 USDC.
   * Do NOT recommend topping Base USDC for Mission 2 until mandate/route changes.
   */
  const mission2Structural = {
    status: "NO-GO_STRUCTURAL",
    reason:
      "base_to_eth_withdraw_fee_~0.30_usdc_vs_policy_floor_and_max_trade_5_usdc",
    evidence:
      "Live quotes 1–5 USDC all POLICY_BLOCKED (amount_out≈in-0.30 USDC; floor=0.99*in)",
    do_not_top_up_base_usdc_for_m2: true,
    alternatives_discovery_only: [
      "base_usdc_to_near_usdc (QUOTE_OK / PASS in matrix)",
      "eth_usdc_to_base_usdc (QUOTE_OK / PASS — reverse direction)",
      "Owner mandate change (raise max_trade_value substantially) — separate approval",
    ],
    reuse_base_usdc: {
      raw: baseUsdc.raw,
      note: "Keep J8B leftover on Base; do not force Mission2 with uneconomic top-up",
    },
  };
  blockers.push("mission2_base_to_eth_structurally_policy_blocked");
  // Drop Base gas funding ask while M2 is deferred
  const bi = blockers.indexOf("need_base_eth_gas");
  if (bi >= 0) blockers.splice(bi, 1);

  const baseUsdcRow = rows.find((r) => r.chain === "base" && r.asset === "USDC");
  if (baseUsdcRow) {
    baseUsdcRow.top_up_raw = "0";
    baseUsdcRow.top_up_ui = 0;
    baseUsdcRow.amount_needed_raw = "0";
    baseUsdcRow.amount_needed_ui = 0;
    baseUsdcRow.buffer_note =
      "NO top-up — Mission2 Base→Eth structurally fails policy at ≤5 USDC due to ~0.30 USDC withdraw fee";
    baseUsdcRow.source_of_funds = "n/a — leave existing Base USDC idle until route/mandate change";
  }
  const baseEthRow = rows.find((r) => r.chain === "base" && r.asset === "ETH");
  if (baseEthRow) {
    baseEthRow.top_up_raw = "0";
    baseEthRow.top_up_ui = 0;
    baseEthRow.amount_needed_raw = "0";
    baseEthRow.amount_needed_ui = 0;
    baseEthRow.buffer_note = "Deferred with Mission2 — no Base gas needed until M2 unblocked";
    baseEthRow.source_of_funds = "n/a";
  }
  totals.base_usdc_top_up = 0;
  totals.base_gas_top_up_eth = 0;
  totals.m2_strategy = "defer_mission2_structural_policy_block";
  totals.m2_proposed_amount_usdc = 0;

  return {
    ok: true,
    mutations_invoked: false,
    status: "AWAITING_COORDINATED_FUNDING",
    mpc: MPC,
    owner: OWNER,
    eth_usd_hint: ethUsdHint,
    live_gas: {
      ethereum: ethGas,
      base: baseGas,
      eth_fee_est: ethFee,
      base_fee_est: baseFee,
    },
    rows,
    totals,
    blockers,
    mission2_structural: mission2Structural,
    hard_stop:
      "No funding transfers, storage_deposit, Ledger, unpause, propose, sign, or broadcast until owner approves this consolidated plan",
  };
}
