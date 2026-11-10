/**
 * Gate J — authoritative balance verification (Sepolia ERC-20 + optional intents).
 * Never invent balances. Fail closed on disagreement.
 */
import { nowIso, REASON } from "./types.mjs";

/**
 * @param {object} opts
 * @param {(evm:string)=>Promise<string>} opts.fetchSepoliaUsdcRaw
 * @param {(evm:string)=>Promise<string>} [opts.fetchSepoliaEthWei]
 * @param {(evm:string)=>Promise<string|{error:string}>} [opts.fetchIntentsUsdc]
 * @param {string} opts.intents_signer_id
 * @param {string} [opts.claimed_balance_usdc_raw] — client claim; must not exceed verified
 * @param {bigint|number} [opts.max_skew_raw=0] — allowed absolute skew vs claimed (default exact)
 */
export async function verifyPortfolioBalances(opts) {
  const {
    fetchSepoliaUsdcRaw,
    fetchSepoliaEthWei,
    fetchIntentsUsdc,
    intents_signer_id,
    claimed_balance_usdc_raw = null,
    max_skew_raw = 0n,
  } = opts;

  const as_of = nowIso();
  const checks = [];
  const push = (name, ok, detail = {}) => checks.push({ name, ok, ...detail });

  if (!intents_signer_id || !/^0x[a-fA-F0-9]{40}$/.test(intents_signer_id)) {
    return {
      ok: false,
      reason: REASON.BALANCE_UNVERIFIED,
      detail: "missing_or_invalid_intents_signer_id",
      checks,
      as_of,
    };
  }

  let sepolia_usdc_raw;
  try {
    sepolia_usdc_raw = String(await fetchSepoliaUsdcRaw(intents_signer_id));
    push("sepolia_usdc_erc20", true, { raw: sepolia_usdc_raw });
  } catch (e) {
    push("sepolia_usdc_erc20", false, {
      error: String(e.message || e).slice(0, 160),
    });
    return {
      ok: false,
      reason: REASON.BALANCE_UNVERIFIED,
      detail: "sepolia_usdc_fetch_failed",
      checks,
      as_of,
    };
  }

  if (!/^\d+$/.test(sepolia_usdc_raw)) {
    return {
      ok: false,
      reason: REASON.BALANCE_UNVERIFIED,
      detail: "sepolia_usdc_non_numeric",
      checks,
      as_of,
    };
  }

  let sepolia_eth_wei = null;
  if (fetchSepoliaEthWei) {
    try {
      sepolia_eth_wei = String(await fetchSepoliaEthWei(intents_signer_id));
      push("sepolia_eth", true, { wei: sepolia_eth_wei });
    } catch (e) {
      push("sepolia_eth", false, { error: String(e.message || e).slice(0, 120) });
    }
  }

  let intents_usdc_raw = null;
  if (fetchIntentsUsdc) {
    try {
      const v = await fetchIntentsUsdc(intents_signer_id);
      if (v && typeof v === "object" && v.error) {
        push("intents_usdc", false, { error: v.error });
      } else {
        intents_usdc_raw = String(v ?? "0");
        push("intents_usdc", true, { raw: intents_usdc_raw });
      }
    } catch (e) {
      push("intents_usdc", false, { error: String(e.message || e).slice(0, 120) });
    }
  }

  // Authoritative spendable for Gate J USDC→wNEAR origin-chain path: Sepolia ERC-20
  const authoritative_usdc_raw = sepolia_usdc_raw;

  if (claimed_balance_usdc_raw != null) {
    try {
      const claimed = BigInt(String(claimed_balance_usdc_raw));
      const auth = BigInt(authoritative_usdc_raw);
      const skew = claimed > auth ? claimed - auth : auth - claimed;
      const maxSkew = typeof max_skew_raw === "bigint" ? max_skew_raw : BigInt(max_skew_raw);
      if (skew > maxSkew) {
        push("claimed_vs_sepolia", false, {
          claimed: String(claimed),
          sepolia: authoritative_usdc_raw,
          skew: String(skew),
        });
        return {
          ok: false,
          reason: REASON.BALANCE_DISCREPANCY,
          detail: {
            claimed: String(claimed),
            sepolia_usdc_raw: authoritative_usdc_raw,
            note: "Client/mandate placeholder must not exceed or invent balances",
          },
          checks,
          as_of,
        };
      }
      push("claimed_vs_sepolia", true);
    } catch {
      return {
        ok: false,
        reason: REASON.BALANCE_UNVERIFIED,
        detail: "claimed_balance_parse_failed",
        checks,
        as_of,
      };
    }
  }

  // Never treat per-trade limit as a balance
  push("not_using_limit_as_balance", true);

  return {
    ok: true,
    as_of,
    intents_signer_id,
    sepolia_usdc_raw: authoritative_usdc_raw,
    sepolia_usdc: Number(authoritative_usdc_raw) / 1e6,
    sepolia_eth_wei,
    intents_usdc_raw,
    balance_usdc_raw: authoritative_usdc_raw,
    source: "sepolia_erc20:USDC",
    checks,
    strategist_balances: {
      usdc: String(Number(authoritative_usdc_raw) / 1e6),
      usdc_raw: authoritative_usdc_raw,
      eth_wei: sepolia_eth_wei,
      intents_usdc_raw,
      as_of,
      source: "sepolia_erc20:USDC",
      verification: "live_read",
    },
  };
}
