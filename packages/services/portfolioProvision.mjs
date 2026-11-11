/**
 * Personal portfolio provisioning / registration (testnet).
 * - Never uses nio-c-* demo credentials.
 * - Requires verified owner session (caller enforces).
 * - register: bind an existing on-chain policy owned by the session account
 * - request_provision: durable request for operator/self provision
 * - self_provision: only when GATE_I_SELF_PROVISION=1 (expensive; optional)
 */
import { randomBytes, createHash } from "node:crypto";
import { DEMO_PREFIX } from "../../scripts/lib/near-live.mjs";

function assertPersonalOwner(accountId) {
  if (!accountId || String(accountId).startsWith(DEMO_PREFIX)) {
    throw new Error("demo_owner_forbidden");
  }
}

function makePortfolioId(ownerAccount) {
  const tag = createHash("sha256")
    .update(String(ownerAccount))
    .digest("hex")
    .slice(0, 4);
  const suffix = randomBytes(2).toString("hex");
  return `i-u-${tag}${suffix}`;
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {(contract:string, method:string, args?:object)=>Promise<any>} deps.viewFunction
 */
export function createPortfolioProvision(deps) {
  const { store, viewFunction, selfProvisionEnabled = false } = deps;

  async function registerExisting({
    owner_account,
    policy_contract,
    portfolio_id: requestedId = null,
  }) {
    assertPersonalOwner(owner_account);
    assertPersonalOwner(policy_contract);

    const onChainOwner = await viewFunction(policy_contract, "get_owner", {});
    if (String(onChainOwner) !== String(owner_account)) {
      return {
        ok: false,
        status: "blocked",
        reason: "policy_owner_mismatch",
        on_chain_owner: onChainOwner,
      };
    }

    let portfolioId =
      requestedId ||
      (await viewFunction(policy_contract, "get_portfolio_id", {}).catch(() => null));
    if (!portfolioId) portfolioId = makePortfolioId(owner_account);
    if (String(portfolioId).includes("/")) {
      return { ok: false, status: "blocked", reason: "invalid_portfolio_id" };
    }

    // Isolation: refuse if another owner already claims this portfolio_id
    const existing = store.getPortfolio(portfolioId);
    if (existing && String(existing.owner_account) !== String(owner_account)) {
      return { ok: false, status: "blocked", reason: "portfolio_id_owned_by_other" };
    }

    const [
      intents_signer_id,
      derivation_path,
      agent_account,
      reconciler_account,
    ] = await Promise.all([
      viewFunction(policy_contract, "get_intents_signer_id", {}),
      viewFunction(policy_contract, "get_derivation_path", {}),
      viewFunction(policy_contract, "get_agent", {}).catch(() => null),
      viewFunction(policy_contract, "get_reconciler", {}).catch(() => null),
    ]);

    if (!intents_signer_id || !String(intents_signer_id).startsWith("0x")) {
      return {
        ok: false,
        status: "blocked",
        reason: "intents_signer_not_bound",
        next_action: "owner_set_intents_signer_id_on_chain",
      };
    }

    const row = store.upsertPortfolio(portfolioId, {
      portfolio_id: portfolioId,
      owner_account,
      policy_contract,
      agent_account: agent_account || null,
      reconciler_account: reconciler_account || null,
      derivation_path:
        typeof derivation_path === "string"
          ? derivation_path
          : `trading/v1/portfolio/${portfolioId}`,
      intents_signer_id: String(intents_signer_id).toLowerCase(),
      created_at: existing?.created_at || new Date().toISOString(),
      deploy_status: "ready",
      provision_source: "owner_register",
      network: "testnet",
      isolated: true,
    });

    return {
      ok: true,
      status: "ready",
      portfolio: row,
      next_action: "fund_deposit_address",
      owner_authenticated: true,
    };
  }

  function requestProvision({ owner_account, notes = null }) {
    assertPersonalOwner(owner_account);
    const existing = Object.values(store.read().portfolios || {}).find(
      (p) => p.owner_account === owner_account && p.deploy_status === "ready"
    );
    if (existing) {
      return {
        ok: true,
        status: "ready",
        portfolio: existing,
        next_action: "fund_deposit_address",
      };
    }

    const request_id = `prov-${randomBytes(8).toString("hex")}`;
    const portfolio_id = makePortfolioId(owner_account);
    store.update((s) => {
      s.provision_requests = s.provision_requests || {};
      s.provision_requests[request_id] = {
        request_id,
        owner_account,
        portfolio_id,
        status: selfProvisionEnabled ? "queued_self" : "awaiting_operator",
        notes,
        created_at: new Date().toISOString(),
      };
      return s;
    });

    // Placeholder portfolio row (not ready for trading)
    store.upsertPortfolio(portfolio_id, {
      portfolio_id,
      owner_account,
      policy_contract: null,
      deploy_status: "awaiting_provision",
      provision_request_id: request_id,
      network: "testnet",
      isolated: true,
      created_at: new Date().toISOString(),
    });

    return {
      ok: true,
      status: selfProvisionEnabled ? "queued_self" : "awaiting_operator",
      request_id,
      portfolio_id,
      self_provision_enabled: selfProvisionEnabled,
      next_action: selfProvisionEnabled
        ? "wait_for_self_provision_worker"
        : "operator_run_gate_i_provision_then_register",
      note: selfProvisionEnabled
        ? "Self-provision flag on; worker must still complete on-chain deploy before trading."
        : "Hosted self-serve deploy requires GATE_I_SELF_PROVISION=1 + funded provisioner. Register an existing owner-controlled policy via action=register.",
    };
  }

  return {
    registerExisting,
    requestProvision,
    makePortfolioId,
  };
}
