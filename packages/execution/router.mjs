/**
 * Multi-route execution engine interface.
 * Adapters must never fake liquidity. Unsupported → UNSUPPORTED_ROUTE / NO_SAFE_LIQUIDITY.
 */

export const ROUTE_STATUS = Object.freeze({
  UNSUPPORTED_ROUTE: "UNSUPPORTED_ROUTE",
  NO_SAFE_LIQUIDITY: "NO_SAFE_LIQUIDITY",
  QUOTED: "QUOTED",
  BLOCKED: "BLOCKED",
});

/**
 * @typedef {object} ExecutionAdapter
 * @property {string} id
 * @property {(req: object) => Promise<object>} quote
 * @property {(req: object) => Promise<object>} [buildTx] — never auto-broadcast
 */

export function createExecutionRouter(adapters = []) {
  const byId = new Map(adapters.map((a) => [a.id, a]));

  return {
    listAdapters() {
      return [...byId.keys()];
    },

    async quoteAll(request) {
      const results = [];
      for (const adapter of byId.values()) {
        try {
          const q = await adapter.quote(request);
          results.push({ adapter: adapter.id, ...q });
        } catch (e) {
          results.push({
            adapter: adapter.id,
            ok: false,
            status: ROUTE_STATUS.BLOCKED,
            reason: String(e.message || e).slice(0, 200),
          });
        }
      }
      return results;
    },

    async quoteBest(request) {
      const all = await this.quoteAll(request);
      const ok = all.filter((r) => r.ok && r.status === ROUTE_STATUS.QUOTED);
      if (!ok.length) {
        return {
          ok: false,
          status: ROUTE_STATUS.NO_SAFE_LIQUIDITY,
          candidates: all,
        };
      }
      ok.sort((a, b) => Number(b.amount_out || 0) - Number(a.amount_out || 0));
      return { ok: true, status: ROUTE_STATUS.QUOTED, best: ok[0], candidates: all };
    },
  };
}

/** 1Click adapter shell — dry quotes only unless caller gates funded. */
export function createNearIntentsAdapter({ dryQuoteFn }) {
  return {
    id: "near_intents_1click",
    async quote(req) {
      if (!dryQuoteFn) {
        return {
          ok: false,
          status: ROUTE_STATUS.UNSUPPORTED_ROUTE,
          reason: "1click_fn_missing",
        };
      }
      const out = await dryQuoteFn({ ...req, dry: true });
      if (!out?.ok) {
        return {
          ok: false,
          status: ROUTE_STATUS.NO_SAFE_LIQUIDITY,
          reason: out?.reason || "quote_failed",
          detail: out,
        };
      }
      return {
        ok: true,
        status: ROUTE_STATUS.QUOTED,
        amount_out: out.amount_out,
        deadline: out.deadline,
        dry: true,
        note: "Dry quote only — not a deposit address",
      };
    },
  };
}

/** 0x / EVM aggregator stub — validates shape, does not sign. */
export function createEvmAggregatorStub({ name = "evm_0x" } = {}) {
  return {
    id: name,
    async quote() {
      return {
        ok: false,
        status: ROUTE_STATUS.UNSUPPORTED_ROUTE,
        reason: "evm_aggregator_not_wired_for_mainnet_mvp",
        note: "Adapter interface ready; production 0x integration is a longer-term gap",
      };
    },
  };
}

export function createNearNativeDexStub() {
  return {
    id: "near_native_dex",
    async quote() {
      return {
        ok: false,
        status: ROUTE_STATUS.UNSUPPORTED_ROUTE,
        reason: "near_native_dex_not_wired",
        note: "Requires maintained venue + storage registration checks",
      };
    },
  };
}

/**
 * Refuse to treat aggregator calldata as signable without decoded binding.
 */
export function validateEvmAggregatorTx(tx) {
  const fails = [];
  if (!tx?.chainId) fails.push("missing_chain_id");
  if (!tx?.to) fails.push("missing_to");
  if (!tx?.data) fails.push("missing_data");
  if (!tx?.spender) fails.push("missing_allowance_spender");
  if (tx?.unlimitedApproval) fails.push("unlimited_approval_forbidden");
  if (!tx?.decoded || !tx.decoded.selector) {
    fails.push("undecoded_calldata_cannot_sign");
  }
  if (fails.length) {
    return { ok: false, reasons: fails, may_sign: false };
  }
  return { ok: true, may_sign: false, note: "Structural OK — still requires policy bind + owner gates" };
}
