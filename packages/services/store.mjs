/**
 * Persistent decision/execution state for hosted services (Gate I3).
 * File-backed JSON — no secrets.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.json");
  const load = () => {
    if (!existsSync(path)) {
      return {
        portfolios: {},
        decisions: [],
        executions: {},
        nonces: {},
        health: { started_at: new Date().toISOString() },
      };
    }
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const save = (state) => {
    writeFileSync(path, JSON.stringify(state, null, 2));
  };
  return {
    path,
    read: load,
    update(fn) {
      const s = load();
      const next = fn(s) || s;
      save(next);
      return next;
    },
    getPortfolio(id) {
      return load().portfolios[id] || null;
    },
    upsertPortfolio(id, patch) {
      return this.update((s) => {
        s.portfolios[id] = { ...(s.portfolios[id] || {}), ...patch, id };
        return s;
      }).portfolios[id];
    },
    recordDecision(decision) {
      return this.update((s) => {
        s.decisions.push(decision);
        if (s.decisions.length > 500) s.decisions = s.decisions.slice(-500);
        return s;
      });
    },
    beginExecution(key, meta) {
      return this.update((s) => {
        if (s.executions[key]?.status === "SUCCESS") {
          return s; // idempotent
        }
        s.executions[key] = {
          ...(s.executions[key] || {}),
          ...meta,
          status: s.executions[key]?.status === "SUCCESS" ? "SUCCESS" : "IN_FLIGHT",
          updated_at: new Date().toISOString(),
        };
        return s;
      }).executions[key];
    },
    finishExecution(key, patch) {
      return this.update((s) => {
        s.executions[key] = {
          ...(s.executions[key] || {}),
          ...patch,
          updated_at: new Date().toISOString(),
        };
        return s;
      }).executions[key];
    },
    nextNonce(evmAddress, observed) {
      return this.update((s) => {
        const cur = BigInt(s.nonces[evmAddress] || "0");
        const obs = BigInt(observed);
        const next = cur > obs ? cur : obs;
        s.nonces[evmAddress] = (next + 1n).toString();
        return s;
      }).nonces[evmAddress];
    },
  };
}
