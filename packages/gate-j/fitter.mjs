/**
 * Gate J — Mandate Fitter (deterministic constrained optimizer).
 * NOT an LLM. Reads authoritative mandate; never changes NEAR policy.
 */
import {
  FIT_OUTCOMES,
  REASON,
  nowIso,
  stableOpId,
  usdFromUsdcRaw,
} from "./types.mjs";

/**
 * @typedef {object} Mandate
 * @property {string} portfolio_id
 * @property {string} owner_account
 * @property {string} policy_contract
 * @property {string} policy_hash
 * @property {string} [policy_version]
 * @property {boolean} revoked
 * @property {boolean} paused
 * @property {string[]} allowed_assets
 * @property {string[]} allowed_networks
 * @property {string} per_trade_limit_usdc_raw
 * @property {string} daily_limit_usdc_raw
 * @property {string} daily_spent_usdc_raw
 * @property {string} balance_usdc_raw
 * @property {string} reserved_pending_exposure
 * @property {string} max_pending_exposure
 * @property {number} max_slippage_bps
 * @property {string[]} [recent_operation_sizes] — for evasion detection
 */

/**
 * @typedef {object} StrategistProposal
 * @property {"TRADE"|"NO_TRADE"} choice
 * @property {{ origin: string, destination: string }} pair
 * @property {string} direction
 * @property {string} proposed_size_usdc_raw
 * @property {string} min_viable_size_usdc_raw
 * @property {string} thesis
 * @property {string} [thesis_id]
 * @property {object} expected_benefit
 * @property {object} estimated_costs
 * @property {number} max_slippage_bps
 * @property {string[]} invariants
 * @property {string} network
 * @property {object[]} [quotes] — optional valid quotes for same strategy
 * @property {object} [selected_quote]
 */

function pushCheck(checks, name, ok, detail = {}) {
  checks.push({ name, ok, ...detail });
}

function thesisPreserved(original, fitted) {
  if (original.pair.origin !== fitted.pair.origin) return false;
  if (original.pair.destination !== fitted.pair.destination) return false;
  if (original.direction !== fitted.direction) return false;
  if ((original.thesis_id || original.thesis) !== (fitted.thesis_id || fitted.thesis)) {
    return false;
  }
  const inv = original.invariants || [];
  for (const key of inv) {
    if (key === "pair" || key === "direction" || key === "thesis" || key === "thesis_id") {
      continue;
    }
    if (JSON.stringify(original[key]) !== JSON.stringify(fitted[key])) return false;
  }
  return true;
}

/**
 * Net economic viability after fees, impact, slippage (bps model).
 * expected_benefit.edge_bps must exceed cost+impact+slippage; size >= min_viable.
 */
export function economicViability({ sizeRaw, proposal, slippageBps }) {
  const size = BigInt(sizeRaw);
  const minViable = BigInt(proposal.min_viable_size_usdc_raw || "0");
  if (size < minViable) {
    return {
      ok: false,
      reason: REASON.MIN_VIABLE_NOT_MET,
      size: size.toString(),
      min_viable: minViable.toString(),
    };
  }
  const edge = Number(proposal.expected_benefit?.edge_bps ?? 0);
  const fee = Number(proposal.estimated_costs?.fee_bps ?? 0);
  const impact = Number(proposal.estimated_costs?.price_impact_bps ?? 0);
  const slip = Number(slippageBps ?? proposal.max_slippage_bps ?? 0);
  const net = edge - fee - impact - slip;
  if (!(edge > 0) || !Number.isFinite(net) || net <= 0) {
    return {
      ok: false,
      reason: REASON.ECONOMIC_NOT_VIABLE,
      edge_bps: edge,
      fee_bps: fee,
      impact_bps: impact,
      slippage_bps: slip,
      net_bps: net,
    };
  }
  return {
    ok: true,
    edge_bps: edge,
    fee_bps: fee,
    impact_bps: impact,
    slippage_bps: slip,
    net_bps: net,
    size_usd: usdFromUsdcRaw(sizeRaw),
  };
}

function pickQuote(proposal, sizeRaw) {
  const quotes = Array.isArray(proposal.quotes) ? proposal.quotes : [];
  const live = quotes.filter((q) => {
    if (!q?.depositAddress || !q?.minAmountOut) return false;
    if (q.deadline && Date.parse(q.deadline) < Date.now() + 30_000) return false;
    if (q.amountIn && String(q.amountIn) !== String(sizeRaw)) return false;
    return true;
  });
  if (live.length) {
    // Prefer highest minAmountOut (deterministic)
    live.sort((a, b) => (BigInt(b.minAmountOut) > BigInt(a.minAmountOut) ? 1 : -1));
    return { quote: live[0], reason: REASON.QUOTE_SELECTED };
  }
  if (proposal.selected_quote) {
    const q = proposal.selected_quote;
    if (q.deadline && Date.parse(q.deadline) < Date.now() + 30_000) {
      return { quote: null, reason: REASON.EXPIRED_QUOTE };
    }
    return { quote: q, reason: null };
  }
  // Fixture / dry path may omit live quotes; still allow fitting on size alone.
  return { quote: null, reason: null };
}

function detectEvasion(mandate, proposedRaw) {
  const limit = BigInt(mandate.per_trade_limit_usdc_raw);
  const proposed = BigInt(proposedRaw);
  if (proposed <= limit) return null;
  const recent = (mandate.recent_operation_sizes || []).map((x) => BigInt(x));
  // Repeated maxed per-trade fills while asking for a larger notional = evasion pattern.
  const maxedFills = recent.filter((x) => x === limit || (x <= limit && x * 2n > limit));
  if (recent.length >= 2 && maxedFills.length >= 2) {
    return REASON.LIMIT_EVASION_ATTEMPT;
  }
  return null;
}

/**
 * Fit a strategist proposal into the owner mandate.
 * @returns {object} fitter result with EXACTLY one of ALLOWED|ADAPTED|REJECTED
 */
export function fitMandate({ proposal, mandate, market = null, critic = null }) {
  const ts = nowIso();
  const checks = [];
  const changes = [];
  const opId = stableOpId("gate-j", [
    mandate.portfolio_id,
    mandate.policy_hash,
    proposal?.proposed_size_usdc_raw,
    proposal?.thesis_id || proposal?.thesis,
    ts.slice(0, 16),
  ]);

  const reject = (code, detail) => ({
    outcome: "REJECTED",
    original_proposal: proposal,
    fitted_proposal: null,
    constraints_checked: checks,
    parameters_changed: changes,
    economic_viability: { ok: false, reason: code },
    policy_hash: mandate.policy_hash,
    policy_version: mandate.policy_version || null,
    portfolio_id: mandate.portfolio_id,
    reason_codes: [code],
    detail,
    operation_id: opId,
    audit_trace: checks,
    timestamp: ts,
    fitter: "deterministic_v1",
  });

  if (!proposal || typeof proposal !== "object") {
    pushCheck(checks, "proposal_shape", false);
    return reject(REASON.MALFORMED_PROPOSAL, "missing proposal");
  }
  pushCheck(checks, "proposal_shape", true);

  if (proposal.choice === "NO_TRADE") {
    pushCheck(checks, "strategist_choice", true, { choice: "NO_TRADE" });
    return reject(REASON.STRATEGIST_NO_TRADE, "Strategist returned NO_TRADE");
  }

  if (mandate.revoked) {
    pushCheck(checks, "mandate_active", false);
    return reject(REASON.MANDATE_REVOKED, "Signing mandate revoked");
  }
  pushCheck(checks, "mandate_active", true);

  if (mandate.paused) {
    pushCheck(checks, "not_paused", false);
    return reject(REASON.POLICY_PAUSED, "Policy paused");
  }
  pushCheck(checks, "not_paused", true);

  if (critic?.verdict === "REJECT") {
    pushCheck(checks, "critic_precheck", false, { verdict: "REJECT" });
    return reject(REASON.CRITIC_VETO, critic.reasons || "critic reject");
  }
  if (critic?.verdict === "ABSTAIN") {
    pushCheck(checks, "critic_precheck", false, { verdict: "ABSTAIN" });
    return reject(REASON.CRITIC_ABSTAIN, critic.reasons || "critic abstain");
  }

  if (market?.stale === true) {
    pushCheck(checks, "market_fresh", false);
    return reject(REASON.STALE_MARKET_DATA, market.reason || "stale market");
  }
  pushCheck(checks, "market_fresh", true, {
    as_of: market?.as_of || null,
  });

  const origin = proposal.pair?.origin;
  const dest = proposal.pair?.destination;
  const assetsOk =
    mandate.allowed_assets.map((a) => a.toUpperCase()).includes(String(origin).toUpperCase()) &&
    mandate.allowed_assets.map((a) => a.toUpperCase()).includes(String(dest).toUpperCase());
  if (!assetsOk) {
    pushCheck(checks, "authorized_assets", false, { origin, dest });
    return reject(REASON.UNAUTHORIZED_ASSET, `${origin}->${dest}`);
  }
  pushCheck(checks, "authorized_assets", true);

  const net = String(proposal.network || "sepolia").toLowerCase();
  if (!mandate.allowed_networks.map((n) => n.toLowerCase()).includes(net)) {
    pushCheck(checks, "authorized_network", false, { network: net });
    return reject(REASON.UNSUPPORTED_NETWORK, net);
  }
  pushCheck(checks, "authorized_network", true, { network: net });

  const evasion = detectEvasion(mandate, proposal.proposed_size_usdc_raw);
  if (evasion) {
    pushCheck(checks, "no_limit_evasion", false);
    return reject(evasion, "chunked ops would evade per-trade limit");
  }
  pushCheck(checks, "no_limit_evasion", true);

  let size = BigInt(proposal.proposed_size_usdc_raw);
  const minViable = BigInt(proposal.min_viable_size_usdc_raw);
  const perTrade = BigInt(mandate.per_trade_limit_usdc_raw);
  const dailyRem =
    BigInt(mandate.daily_limit_usdc_raw) - BigInt(mandate.daily_spent_usdc_raw);
  const balance = BigInt(mandate.balance_usdc_raw);
  const reserved = BigInt(mandate.reserved_pending_exposure || "0");
  const maxPending = BigInt(mandate.max_pending_exposure || "0");

  if (dailyRem <= 0n) {
    pushCheck(checks, "daily_limit", false, { remaining: dailyRem.toString() });
    return reject(REASON.DAILY_LIMIT_EXHAUSTED, "daily limit exhausted");
  }
  pushCheck(checks, "daily_limit", true, { remaining: dailyRem.toString() });

  if (balance < minViable) {
    pushCheck(checks, "balance", false, { balance: balance.toString() });
    return reject(REASON.INSUFFICIENT_BALANCE, "balance below min viable");
  }
  pushCheck(checks, "balance", true);

  // Cap by mandate — NEVER increase limits
  const hardCap = [perTrade, dailyRem, balance].reduce((a, b) => (a < b ? a : b));
  if (hardCap < minViable) {
    pushCheck(checks, "hard_cap_vs_min_viable", false, {
      hard_cap: hardCap.toString(),
      min_viable: minViable.toString(),
    });
    return reject(
      REASON.MIN_VIABLE_NOT_MET,
      `hard cap ${hardCap} < min viable ${minViable}`
    );
  }
  pushCheck(checks, "hard_cap_vs_min_viable", true);

  let outcome = "ALLOWED";
  if (size > hardCap) {
    size = hardCap;
    outcome = "ADAPTED";
    changes.push({
      parameter: "proposed_size_usdc_raw",
      from: proposal.proposed_size_usdc_raw,
      to: size.toString(),
      why: REASON.SIZE_REDUCED_TO_LIMIT,
    });
  }

  if (reserved + size > maxPending && maxPending > 0n) {
    const headroom = maxPending - reserved;
    if (headroom < minViable) {
      pushCheck(checks, "pending_exposure", false, {
        reserved: reserved.toString(),
        headroom: headroom.toString(),
      });
      return reject(REASON.PENDING_EXPOSURE, "insufficient pending headroom");
    }
    if (size > headroom) {
      size = headroom;
      outcome = "ADAPTED";
      changes.push({
        parameter: "proposed_size_usdc_raw",
        from: proposal.proposed_size_usdc_raw,
        to: size.toString(),
        why: REASON.PENDING_EXPOSURE,
      });
    }
  }
  pushCheck(checks, "pending_exposure", true);

  let slip = Number(proposal.max_slippage_bps || 0);
  if (slip > mandate.max_slippage_bps) {
    slip = mandate.max_slippage_bps;
    outcome = "ADAPTED";
    changes.push({
      parameter: "max_slippage_bps",
      from: proposal.max_slippage_bps,
      to: slip,
      why: REASON.SLIPPAGE_CLAMPED,
    });
  }
  pushCheck(checks, "slippage_bounds", true, { slippage_bps: slip });

  const fittedBase = {
    ...proposal,
    choice: "TRADE",
    proposed_size_usdc_raw: size.toString(),
    max_slippage_bps: slip,
    fitted: true,
  };

  if (!thesisPreserved(proposal, fittedBase)) {
    pushCheck(checks, "thesis_preserved", false);
    return reject(REASON.THESIS_INVALIDATED, "fit would change strategy invariants");
  }
  pushCheck(checks, "thesis_preserved", true);

  const qPick = pickQuote({ ...proposal, selected_quote: proposal.selected_quote }, size.toString());
  if (qPick.reason === REASON.EXPIRED_QUOTE) {
    pushCheck(checks, "quote", false);
    return reject(REASON.EXPIRED_QUOTE, "selected quote expired");
  }
  if (qPick.quote) {
    fittedBase.selected_quote = {
      ...qPick.quote,
      amountIn: size.toString(),
    };
    if (qPick.reason) {
      changes.push({
        parameter: "selected_quote",
        from: proposal.selected_quote?.depositAddress || null,
        to: qPick.quote.depositAddress,
        why: qPick.reason,
      });
      if (outcome === "ALLOWED" && size === BigInt(proposal.proposed_size_usdc_raw) && slip === Number(proposal.max_slippage_bps || 0)) {
        // quote swap alone counts as ADAPTED only if different from original
        if (
          proposal.selected_quote?.depositAddress &&
          proposal.selected_quote.depositAddress !== qPick.quote.depositAddress
        ) {
          outcome = "ADAPTED";
        }
      }
    }
  }
  pushCheck(checks, "quote", true);

  const econ = economicViability({
    sizeRaw: size.toString(),
    proposal: fittedBase,
    slippageBps: slip,
  });
  pushCheck(checks, "economic_viability", econ.ok, econ);
  if (!econ.ok) {
    return reject(econ.reason || REASON.ECONOMIC_NOT_VIABLE, econ);
  }

  if (size < minViable) {
    return reject(REASON.MIN_VIABLE_NOT_MET, "post-fit size below min viable");
  }

  if (outcome === "ALLOWED") {
    pushCheck(checks, "already_within_mandate", true);
  }

  if (!FIT_OUTCOMES.includes(outcome)) {
    throw new Error("invalid_fit_outcome");
  }

  return {
    outcome,
    original_proposal: proposal,
    fitted_proposal: fittedBase,
    constraints_checked: checks,
    parameters_changed: changes,
    economic_viability: econ,
    policy_hash: mandate.policy_hash,
    policy_version: mandate.policy_version || null,
    portfolio_id: mandate.portfolio_id,
    reason_codes:
      outcome === "ALLOWED"
        ? [REASON.ALREADY_WITHIN_MANDATE]
        : changes.map((c) => c.why),
    operation_id: opId,
    audit_trace: checks,
    timestamp: ts,
    fitter: "deterministic_v1",
  };
}
