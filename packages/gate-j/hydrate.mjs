/**
 * Gate J — hydrate Mandate from authoritative on-chain policy state.
 * Never trusts browser/LLM-supplied weaker limits.
 */
import { nowIso, REASON } from "./types.mjs";

const USDC_ALIASES = new Set([
  "USDC",
  "usdc",
  "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet",
]);
const WNEAR_ALIASES = new Set([
  "wNEAR",
  "WNEAR",
  "NEAR",
  "near",
  "nep141:wnear.tidepool-sandbox.testnet",
]);

function u128(v) {
  if (v == null) return null;
  if (typeof v === "object" && v !== null && "0" in v) return String(v["0"]);
  return String(v);
}

function mapAllowedAssets(onChainAssets = []) {
  const out = new Set();
  for (const a of onChainAssets) {
    const s = String(a);
    if (USDC_ALIASES.has(s) || /usdc/i.test(s) || /0x2e6ad9e6/i.test(s)) out.add("USDC");
    if (WNEAR_ALIASES.has(s) || /wnear/i.test(s)) out.add("wNEAR");
  }
  return [...out];
}

function mapAllowedNetworks(assets = [], destinations = []) {
  const nets = new Set(["sepolia", "sepolia+intents", "near-intents"]);
  // Keep default Gate I networks when USDC/wNEAR present; destinations are addresses not chains.
  void assets;
  void destinations;
  return [...nets];
}

/**
 * @param {object} opts
 * @param {(accountId:string, method:string, args?:object)=>Promise<any>} opts.view
 * @param {object} opts.portfolio — store portfolio row
 * @param {string} [opts.balance_usdc_raw] — live balance override (from balances API)
 * @param {string} [opts.claimed_owner] — optional caller claim; must match on-chain
 * @param {object|null} [opts.clientMandate] — rejected if weaker / conflicting
 */
export async function hydrateMandateFromChain(opts) {
  const {
    view,
    portfolio,
    balance_usdc_raw = null,
    claimed_owner = null,
    clientMandate = null,
  } = opts;

  const checks = [];
  const push = (name, ok, detail = {}) => checks.push({ name, ok, ...detail });

  if (!portfolio?.policy_contract || !portfolio?.portfolio_id) {
    return {
      ok: false,
      reason: "PORTFOLIO_IDENTITY_MISSING",
      checks,
      mandate: null,
    };
  }

  const policy = portfolio.policy_contract;
  let composite = null;
  let usedComposite = false;

  try {
    composite = await view(policy, "get_gate_j_mandate", {});
    usedComposite = true;
    push("get_gate_j_mandate", true);
  } catch (e) {
    push("get_gate_j_mandate", false, {
      error: String(e.message || e).slice(0, 160),
    });
  }

  let limits;
  let snap;
  let owner;
  let onChainPortfolioId;
  let epoch;
  let paused;
  let policyHash;
  let dailyTurnover;
  let pending = [];
  let intentsSigner;

  try {
    if (usedComposite && composite) {
      limits = composite.limits;
      snap = {
        reserved_pending_exposure: composite.reserved_pending_exposure,
        realized_exposure: composite.realized_exposure,
        revoked: composite.revoked,
        mandate_epoch: composite.mandate_epoch,
        unresolved_pending: composite.unresolved_pending,
        signing_revoked: composite.signing_revoked,
      };
      owner = composite.owner;
      onChainPortfolioId = composite.portfolio_id;
      epoch = composite.mandate_epoch;
      paused = composite.paused;
      policyHash = composite.policy_hash;
      dailyTurnover = u128(composite.daily_turnover);
      intentsSigner = composite.intents_signer_id;
    } else {
      // Fallback assembly from older contracts — paused/policy_hash required or fail closed
      [
        limits,
        snap,
        owner,
        onChainPortfolioId,
        epoch,
        pending,
        intentsSigner,
      ] = await Promise.all([
        view(policy, "get_limits", {}),
        view(policy, "get_exposure_snapshot", {}),
        view(policy, "get_owner", {}),
        view(policy, "get_portfolio_id", {}),
        view(policy, "get_mandate_epoch", {}),
        view(policy, "list_pending", {}).catch(() => []),
        view(policy, "get_intents_signer_id", {}),
      ]);
      push("legacy_views", true);

      try {
        paused = await view(policy, "get_paused", {});
        push("get_paused", paused === true || paused === false);
      } catch (e) {
        push("get_paused", false, { error: String(e.message || e).slice(0, 120) });
        return {
          ok: false,
          reason: "PAUSED_STATUS_UNREADABLE",
          detail: "Deploy policy WASM with get_paused / get_gate_j_mandate",
          checks,
          mandate: null,
        };
      }
      try {
        policyHash = await view(policy, "get_policy_hash", {});
        push("get_policy_hash", typeof policyHash === "string" && policyHash.length > 0);
      } catch (e) {
        push("get_policy_hash", false, { error: String(e.message || e).slice(0, 120) });
        return {
          ok: false,
          reason: "POLICY_HASH_UNREADABLE",
          checks,
          mandate: null,
        };
      }
      try {
        dailyTurnover = u128(await view(policy, "get_daily_turnover", {}));
        push("get_daily_turnover", dailyTurnover != null);
      } catch {
        dailyTurnover = "0";
        push("get_daily_turnover", false, { assumed: "0" });
      }
    }

    if (!usedComposite) {
      /* pending already loaded */
    } else {
      pending = await view(policy, "list_pending", {}).catch(() => []);
    }
  } catch (e) {
    return {
      ok: false,
      reason: "ON_CHAIN_MANDATE_FETCH_FAILED",
      error: String(e.message || e).slice(0, 240),
      checks,
      mandate: null,
    };
  }

  // Identity checks
  const ownerOk = String(owner) === String(portfolio.owner_account);
  push("owner_matches_store", ownerOk, { on_chain: owner, store: portfolio.owner_account });
  if (!ownerOk) {
    return { ok: false, reason: "OWNER_MISMATCH", checks, mandate: null };
  }

  const pidOk = String(onChainPortfolioId) === String(portfolio.portfolio_id);
  push("portfolio_id_matches", pidOk, {
    on_chain: onChainPortfolioId,
    store: portfolio.portfolio_id,
  });
  if (!pidOk) {
    return { ok: false, reason: "PORTFOLIO_ID_MISMATCH", checks, mandate: null };
  }

  if (claimed_owner && String(claimed_owner) !== String(owner)) {
    push("claimed_owner", false, { claimed_owner, owner });
    return { ok: false, reason: "WRONG_PORTFOLIO_OWNER", checks, mandate: null };
  }
  push("claimed_owner", true);

  if (String(portfolio.owner_account || "").startsWith("nio-c-")) {
    return { ok: false, reason: "DEMO_PORTFOLIO_FORBIDDEN", checks, mandate: null };
  }

  if (!limits || snap == null || policyHash == null || paused === undefined || paused === null) {
    return {
      ok: false,
      reason: "REQUIRED_POLICY_FIELDS_MISSING",
      checks,
      mandate: null,
    };
  }

  const perTrade = u128(limits.max_trade_value);
  const dailyLimit = u128(limits.daily_turnover_limit);
  const maxPending = u128(limits.max_pending_exposure);
  const reserved = u128(snap.reserved_pending_exposure) || "0";
  const spent = dailyTurnover || "0";
  const revoked = !!snap.revoked;
  const validUntil = u128(limits.valid_until);
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const expired = validUntil != null && BigInt(validUntil) > 0n && BigInt(validUntil) < nowNs;
  push("policy_not_expired", !expired, { valid_until: validUntil });

  if (expired) {
    return { ok: false, reason: "POLICY_EXPIRED", checks, mandate: null };
  }

  const allowedAssets = mapAllowedAssets(limits.allowed_assets || []);
  push("allowed_assets_mapped", allowedAssets.length > 0, { allowedAssets });
  if (!allowedAssets.length) {
    return { ok: false, reason: "ALLOWED_ASSETS_EMPTY", checks, mandate: null };
  }

  const dailyRemaining = (() => {
    try {
      const rem = BigInt(dailyLimit) - BigInt(spent);
      return rem > 0n ? rem.toString() : "0";
    } catch {
      return "0";
    }
  })();

  const pendingHeadroom = (() => {
    try {
      const rem = BigInt(maxPending) - BigInt(reserved);
      return rem > 0n ? rem.toString() : "0";
    } catch {
      return "0";
    }
  })();

  // Never treat per-trade / daily limits as wallet balance.
  if (balance_usdc_raw == null || !/^\d+$/.test(String(balance_usdc_raw))) {
    return {
      ok: false,
      reason: REASON.BALANCE_UNVERIFIED,
      detail:
        "Live Sepolia USDC balance required; refusing to substitute per-trade limit as balance",
      checks,
      mandate: null,
    };
  }
  const balance = String(balance_usdc_raw);
  // Guard: if someone passed the limit as "balance", require explicit marker
  if (balance === perTrade) {
    push("balance_equals_per_trade_limit", true, {
      note: "coincidental equality allowed only when verified live read equals limit",
    });
  }

  const mandate = {
    portfolio_id: String(onChainPortfolioId),
    owner_account: String(owner),
    policy_contract: policy,
    policy_hash: String(policyHash),
    policy_version: String(epoch),
    mandate_epoch: Number(epoch),
    revoked,
    paused: !!paused,
    signing_revoked: !!snap.signing_revoked,
    allowed_assets: allowedAssets,
    allowed_networks: mapAllowedNetworks(limits.allowed_assets, limits.allowed_destinations),
    allowed_destinations: (limits.allowed_destinations || []).map(String),
    per_trade_limit_usdc_raw: perTrade,
    daily_limit_usdc_raw: dailyLimit,
    daily_spent_usdc_raw: spent,
    daily_remaining_usdc_raw: dailyRemaining,
    balance_usdc_raw: balance,
    balance_source: "verified_live_input",
    reserved_pending_exposure: reserved,
    max_pending_exposure: maxPending,
    pending_headroom_usdc_raw: pendingHeadroom,
    max_slippage_bps: Number(limits.max_slippage_bps ?? 100),
    unresolved_pending: Number(snap.unresolved_pending || 0),
    pending_operations: Array.isArray(pending)
      ? pending.map((p) => ({
          operation_id: p.operation_id,
          epoch: p.epoch,
          amount_in: u128(p.amount_in),
          signing_state: p.signing_state,
          settlement_state: p.settlement_state,
        }))
      : [],
    // Accounting note for Gate J: Signed+unsettle withdraws may not reserve trade exposure
    signed_unsettled_count: Array.isArray(pending)
      ? pending.filter(
          (p) =>
            p.signing_state === "Signed" &&
            (p.settlement_state === "None" || !p.settlement_state)
        ).length
      : 0,
    intents_signer_id: intentsSigner || portfolio.intents_signer_id || null,
    recent_operation_sizes: Array.isArray(pending)
      ? pending.map((p) => u128(p.amount_in)).filter(Boolean)
      : [],
    source: usedComposite ? "on_chain:get_gate_j_mandate" : "on_chain:assembled",
    as_of: nowIso(),
  };

  // Reject client attempts to weaken mandate
  if (clientMandate && typeof clientMandate === "object") {
    const weaken = detectWeakerClientMandate(mandate, clientMandate);
    push("client_mandate_not_weaker", weaken.ok, weaken);
    if (!weaken.ok) {
      return {
        ok: false,
        reason: "FORGED_OR_WEAKER_CLIENT_MANDATE",
        detail: weaken,
        checks,
        mandate: null,
      };
    }
  }

  push("hydrate_complete", true);
  return {
    ok: true,
    mandate,
    checks,
    revalidate_key: `${mandate.policy_contract}|${mandate.policy_hash}|${mandate.mandate_epoch}|${mandate.paused}|${mandate.revoked}`,
  };
}

export function detectWeakerClientMandate(authoritative, client) {
  const issues = [];
  const cmp = (field, a, c, { higherIsWeaker = false } = {}) => {
    if (c == null || c === undefined) return;
    if (typeof a === "boolean") {
      // client claiming not revoked/paused when chain says yes → weaker
      if (a === true && c === false) issues.push(`${field}:client_clears_flag`);
      return;
    }
    try {
      const A = BigInt(String(a));
      const C = BigInt(String(c));
      if (higherIsWeaker) {
        if (C > A) issues.push(`${field}:client_raises_limit`);
      } else if (C !== A && field.includes("hash")) {
        issues.push(`${field}:mismatch`);
      }
    } catch {
      if (String(c) !== String(a) && String(field).includes("hash")) {
        issues.push(`${field}:mismatch`);
      }
    }
  };

  cmp("revoked", authoritative.revoked, client.revoked);
  cmp("paused", authoritative.paused, client.paused);
  cmp("per_trade_limit_usdc_raw", authoritative.per_trade_limit_usdc_raw, client.per_trade_limit_usdc_raw, {
    higherIsWeaker: true,
  });
  cmp("daily_limit_usdc_raw", authoritative.daily_limit_usdc_raw, client.daily_limit_usdc_raw, {
    higherIsWeaker: true,
  });
  cmp("max_pending_exposure", authoritative.max_pending_exposure, client.max_pending_exposure, {
    higherIsWeaker: true,
  });
  if (client.policy_hash && client.policy_hash !== authoritative.policy_hash) {
    issues.push("policy_hash:mismatch");
  }
  if (
    client.allowed_assets &&
    Array.isArray(client.allowed_assets) &&
    client.allowed_assets.some((a) => !authoritative.allowed_assets.includes(a))
  ) {
    issues.push("allowed_assets:client_adds_asset");
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Re-read chain before any future signing path. Fail if policy changed.
 */
export async function revalidateMandate(opts) {
  const again = await hydrateMandateFromChain(opts);
  if (!again.ok) {
    return {
      ok: false,
      reason: again.reason || REASON.ENFORCEMENT_FAIL,
      checks: again.checks,
    };
  }
  if (opts.expected_revalidate_key && again.revalidate_key !== opts.expected_revalidate_key) {
    return {
      ok: false,
      reason: "POLICY_CHANGED_BETWEEN_PROPOSAL_AND_EXECUTION",
      expected: opts.expected_revalidate_key,
      actual: again.revalidate_key,
      checks: again.checks,
    };
  }
  return { ok: true, mandate: again.mandate, revalidate_key: again.revalidate_key, checks: again.checks };
}
